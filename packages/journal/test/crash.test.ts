// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { AuditLog, openDatabase } from "@axis/audit";
import { Journal, RUN_TRANSITIONS, WORKSPACE_TRANSITIONS } from "../src/index.js";
import { STEPS, deterministicJournal, snapshot, type Ctx } from "./fixtures/script.js";

/** A held lock for in-process recovery; the child fixtures and lock tests exercise the real one. */
const LOCK = { path: ":test:", held: true, release() {} };
const CHILD = fileURLToPath(new URL("./fixtures/child.js", import.meta.url));

/** Spawn the fixture, wait for READY, SIGKILL it (after `delayMs`), and confirm it died by signal. */
async function crashChild(dbPath: string, mode: string, k: number, delayMs = 0): Promise<void> {
  const child = spawn(process.execPath, [CHILD, dbPath, mode, String(k)], { stdio: ["ignore", "pipe", "inherit"] });
  const exit = new Promise<string>((resolve) => child.on("exit", (code, signal) => resolve(signal ?? `code:${String(code)}`)));
  await new Promise<void>((resolve, reject) => {
    let buf = "";
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString();
      if (buf.includes("READY")) resolve();
    });
    child.on("error", reject);
    void exit.then((how) => reject(new Error(`child exited before READY: ${how}`)));
  });
  if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  child.kill("SIGKILL");
  assert.equal(await exit, "SIGKILL");
}

function reference(k: number): unknown {
  const { journal } = deterministicJournal(openDatabase(":memory:"));
  const ctx: Ctx = { ws: "", r1: "", r2: "", ws2: "" };
  for (let i = 0; i < k; i++) STEPS[i]?.(journal, ctx);
  return snapshot(journal);
}

/** Invariants that must hold after any crash, before and after recovery. */
function assertConsistent(db: ReturnType<typeof openDatabase>, journal: Journal, audit: AuditLog): void {
  const check = db.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
  assert.equal(check.integrity_check, "ok");
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(audit.verify().ok, true, "audit chain must verify after a crash");
  assert.equal(db.isTransaction, false);

  const entities: Array<["workspace" | "run", string, string, Readonly<Record<string, readonly string[]>>]> = [
    ...journal.listWorkspaces({ includeRemoved: true }).map((w): ["workspace", string, string, Readonly<Record<string, readonly string[]>>] => ["workspace", w.id, w.state, WORKSPACE_TRANSITIONS]),
    ...journal.listRuns().map((r): ["run", string, string, Readonly<Record<string, readonly string[]>>] => ["run", r.id, r.state, RUN_TRANSITIONS]),
  ];
  for (const [entity, id, state, table] of entities) {
    const history = journal.transitions(entity, id);
    assert.ok(history.length > 0, `${entity} ${id} has no journal history`);
    assert.equal(history.at(-1)?.to, state, `${entity} ${id}: state must equal its last journaled transition`);
    let prev: string | null = null;
    for (const t of history) {
      assert.equal(t.from, prev);
      if (prev !== null) assert.ok(table[prev]?.includes(t.to), `${entity} ${id}: ${prev} -> ${t.to} is not a legal transition`);
      prev = t.to;
    }
  }
}

function fresh(): { dir: string; path: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "axis-journal-"));
  return { dir, path: join(dir, "journal.db"), done: () => rmSync(dir, { recursive: true, force: true }) };
}

for (const mode of ["after-commit", "open-tx"] as const) {
  test(`kill-and-recover matrix (${mode}): SIGKILL at every step boundary leaves a consistent, recoverable journal`, async () => {
    const { path, done } = fresh();
    try {
      for (let k = 0; k <= STEPS.length; k++) {
        if (mode === "open-tx" && k === STEPS.length) continue; // no step k+1 to leave open
        rmSync(path, { force: true });
        rmSync(`${path}-wal`, { force: true });
        rmSync(`${path}-shm`, { force: true });
        await crashChild(path, mode === "open-tx" ? "open-tx" : "commit", k);

        const db = openDatabase(path);
        const { journal, audit } = deterministicJournal(db);
        // The uncommitted step (open-tx) must be absent; committed steps must be present.
        assert.deepEqual(snapshot(journal), reference(k), `state after kill at step ${k}`);
        assertConsistent(db, journal, audit);

        const before = audit.head()?.seq ?? 0;
        const report = journal.recover(LOCK);
        const stillRunning = journal.listRuns({ states: ["RUNNING"] });
        assert.deepEqual(stillRunning, []);
        assert.equal(journal.listWorkspaces().filter((w) => w.state === "CREATING").length, 0);
        assert.equal(audit.list({ afterSeq: before }).length, report.runsInterrupted.length + report.workspacesFailed.length + report.workspacesNeedingReconcile.length);
        assertConsistent(db, journal, audit);

        // Recovery converges: a second pass has nothing to do.
        // REMOVING workspaces are re-reported (the worktree manager still owes them work) but never re-audited.
        const afterFirst = audit.head()?.seq ?? 0;
        const again = journal.recover(LOCK);
        assert.deepEqual([again.runsInterrupted, again.workspacesFailed], [[], []]);
        assert.deepEqual(again.workspacesNeedingReconcile, report.workspacesNeedingReconcile);
        assert.equal(audit.head()?.seq ?? 0, afterFirst, "a repeated recovery must not write audit events");
        db.close();
      }
    } finally {
      done();
    }
  });
}

test("killed mid-recovery: the half-done recovery rolls back, a second recovery completes it", async () => {
  const { path, done } = fresh();
  try {
    await crashChild(path, "recover-open-tx", 6); // both runs RUNNING, recovery open but uncommitted
    const db = openDatabase(path);
    const { journal, audit } = deterministicJournal(db);
    assert.deepEqual(journal.listRuns({ states: ["RUNNING"] }).length, 2);
    assert.equal(audit.head(), null, "no audit event from the uncommitted recovery");
    assertConsistent(db, journal, audit);

    const report = journal.recover(LOCK);
    assert.equal(report.runsInterrupted.length, 2);
    assert.equal(audit.list().length, 2);
    for (const e of audit.list()) {
      assert.equal(e.action, "journal.recovery");
      assert.equal(e.actor, "daemon");
      assert.deepEqual(Object.keys(e.payload as object).sort(), ["from", "kind", "reason", "to", "workspaceId"]);
    }
    assertConsistent(db, journal, audit);
    db.close();
  } finally {
    done();
  }
});

test("a killed writer does not leave the database locked for the next daemon", async () => {
  const { path, done } = fresh();
  try {
    await crashChild(path, "open-tx", 3);
    const db = openDatabase(path, { busyTimeoutMs: 200 });
    const { journal } = deterministicJournal(db);
    // Would throw SQLITE_BUSY if the dead process still held the write lock.
    const run = journal.listRuns()[0];
    assert.ok(run);
    journal.transitionRun(run.id, "CANCELLED");
    db.close();
  } finally {
    done();
  }
});

test("recovery never deletes rows", async () => {
  const { path, done } = fresh();
  try {
    await crashChild(path, "commit", 8);
    const db = openDatabase(path);
    const { journal } = deterministicJournal(db);
    const before = journal.listRuns().length;
    journal.recover(LOCK);
    assert.equal(journal.listRuns().length, before);
    assert.equal(journal.listWorkspaces({ includeRemoved: true }).length, 1);
    db.close();
  } finally {
    done();
  }
});

test("S11: SIGKILL at random instants while the child commits in a loop (including inside COMMIT) never corrupts state", async () => {
  for (let i = 0; i < 12; i++) {
    const { path, done } = fresh();
    try {
      await crashChild(path, "fuzz", 0, Math.floor(Math.random() * 50));
      const db = openDatabase(path);
      const { journal, audit } = deterministicJournal(db);
      assertConsistent(db, journal, audit);
      // Every committed run is whole: its journal row and its history agree (checked above), and none is half-created.
      journal.recover(LOCK);
      assertConsistent(db, journal, audit);
      assert.equal(journal.listRuns({ states: ["RUNNING"] }).length, 0);
      db.close();
    } finally {
      done();
    }
  }
});

test("S11: an uncommitted transaction large enough to spill the page cache to the WAL file still vanishes on kill", async () => {
  const { path, done } = fresh();
  try {
    await crashChild(path, "spill", 0, 150);
    const db = openDatabase(path);
    const { journal, audit } = deterministicJournal(db);
    assert.equal(journal.listRuns().length, 0, "nothing from the uncommitted transaction may survive");
    assert.equal(journal.listWorkspaces().length, 1);
    assertConsistent(db, journal, audit);
    db.close();
  } finally {
    done();
  }
});
