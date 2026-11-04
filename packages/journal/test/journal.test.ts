// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { AuditLog, AxisError, acquireInstanceLock, openDatabase, schemaVersion } from "@axis/audit";
import * as daemonPrincipal from "../src/daemon-principal.js";
import { userPrincipal } from "../src/daemon-principal.js";
import { JOURNAL_SCHEMA_VERSION, Journal, RESTART_REASON, RUN_STATES, RUN_TRANSITIONS, type RunState } from "../src/index.js";

const USER = userPrincipal();

// Low-entropy stand-ins assembled at runtime; none is a credential.
const FAKE = { anthropic: "sk-" + "ant-" + "A1b2".repeat(8), password: "hunter2-" + "pw".repeat(6) };
/** A real instance lock. In-memory databases have no directory, so any held lock guards them. */
const LOCK_DIR = mkdtempSync(join(tmpdir(), "axis-journal-lock-"));
const LOCK = acquireInstanceLock(LOCK_DIR);
after(() => {
  LOCK.release();
  rmSync(LOCK_DIR, { recursive: true, force: true });
});

const KEY1 = "00000000-0000-4000-8000-000000000001";
const KEY2 = "00000000-0000-4000-8000-000000000002";
const SHA = "b".repeat(40);

function setup() {
  const db = openDatabase(":memory:");
  const audit = new AuditLog(db);
  const journal = Journal.open(db, { audit });
  return { db, audit, journal };
}

function readyWorkspace(journal: Journal) {
  const ws = journal.createWorkspace({ projectId: "p", branch: "axis/x", baseRef: "main", baseSha: SHA, createdBy: "user" }).value;
  return journal.transitionWorkspace(ws.id, "READY");
}

const code = (c: string) => (e: unknown) => e instanceof AxisError && e.code === c;

test("opening migrates the schema once and records the version", () => {
  const { db } = setup();
  assert.equal(schemaVersion(db, "journal"), JOURNAL_SCHEMA_VERSION);
  Journal.open(db, { audit: new AuditLog(db) });
  assert.equal(schemaVersion(db, "journal"), JOURNAL_SCHEMA_VERSION);
  db.prepare("UPDATE axis_schema SET version = 42 WHERE component = 'journal'").run();
  assert.throws(() => Journal.open(db, { audit: new AuditLog(db) }), code("E_UNAVAILABLE"));
});

test("workspace lifecycle: CREATING, READY, REMOVING, REMOVED with a transition history", () => {
  const { journal } = setup();
  const ws = readyWorkspace(journal);
  journal.transitionWorkspace(ws.id, "REMOVING", { actor: "user", reason: "USER_REMOVED" });
  const removed = journal.transitionWorkspace(ws.id, "REMOVED");
  assert.equal(removed.state, "REMOVED");
  assert.deepEqual(journal.transitions("workspace", ws.id).map((t) => [t.from, t.to]), [
    [null, "CREATING"],
    ["CREATING", "READY"],
    ["READY", "REMOVING"],
    ["REMOVING", "REMOVED"],
  ]);
  assert.equal(journal.listWorkspaces().length, 0);
  assert.equal(journal.listWorkspaces({ includeRemoved: true }).length, 1);
  assert.throws(() => journal.transitionWorkspace(ws.id, "READY"), code("E_CONFLICT"));
});

test("run state machine allows exactly the documented transitions", () => {
  const { journal } = setup();
  const ws = readyWorkspace(journal);
  for (const from of RUN_STATES) {
    for (const to of RUN_STATES) {
      // Walk a fresh run into `from` along a legal path, then try `to`.
      const run = journal.createRun({ workspaceId: ws.id, kind: "cli", createdBy: "user" }).value;
      const path: Record<RunState, RunState[]> = {
        QUEUED: [],
        RUNNING: ["RUNNING"],
        REVIEWING: ["RUNNING", "REVIEWING"],
        BLOCKED: ["RUNNING", "BLOCKED"],
        COMPLETED: ["RUNNING", "REVIEWING", "COMPLETED"],
        FAILED: ["RUNNING", "FAILED"],
        CANCELLED: ["CANCELLED"],
      };
      for (const step of path[from]) journal.transitionRun(run.id, step, { actor: USER });
      if (RUN_TRANSITIONS[from].includes(to)) {
        assert.equal(journal.transitionRun(run.id, to, { actor: USER }).state, to, `${from} -> ${to}`);
      } else {
        assert.throws(() => journal.transitionRun(run.id, to, { actor: USER }), code("E_CONFLICT"), `${from} -> ${to}`);
        assert.equal(journal.getRun(run.id)?.state, from);
      }
    }
  }
});

test("terminal states are final; started/ended timestamps and exit code are recorded", () => {
  let t = 0;
  const db = openDatabase(":memory:");
  const journal = Journal.open(db, { audit: new AuditLog(db), now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, ++t)) });
  const ws = readyWorkspace(journal);
  const run = journal.createRun({ workspaceId: ws.id, kind: "composer", createdBy: "user" }).value;
  assert.equal(run.state, "QUEUED");
  assert.equal(run.startedAt, null);
  const running = journal.transitionRun(run.id, "RUNNING");
  assert.ok(running.startedAt);
  const done = journal.transitionRun(run.id, "FAILED", { reason: "NONZERO_EXIT", exitCode: 2 });
  assert.equal(done.exitCode, 2);
  assert.equal(done.reason, "NONZERO_EXIT");
  assert.ok(done.endedAt);
  assert.throws(() => journal.transitionRun(run.id, "RUNNING"), code("E_CONFLICT"));
});

test("runs need a READY workspace; unknown ids are E_NOT_FOUND", () => {
  const { journal } = setup();
  const ws = journal.createWorkspace({ projectId: "p", branch: "b", baseRef: "main", baseSha: SHA, createdBy: "user" }).value;
  assert.throws(() => journal.createRun({ workspaceId: ws.id, kind: "cli", createdBy: "user" }), code("E_CONFLICT"));
  assert.throws(() => journal.createRun({ workspaceId: "nope", kind: "cli", createdBy: "user" }), code("E_NOT_FOUND"));
  assert.throws(() => journal.transitionRun("nope", "RUNNING"), code("E_NOT_FOUND"));
});

test("expectedFrom makes a transition conditional", () => {
  const { journal } = setup();
  const ws = readyWorkspace(journal);
  const run = journal.createRun({ workspaceId: ws.id, kind: "cli", createdBy: "user" }).value;
  assert.throws(() => journal.transitionRun(run.id, "RUNNING", { expectedFrom: "BLOCKED" }), code("E_CONFLICT"));
  assert.equal(journal.transitionRun(run.id, "RUNNING", { expectedFrom: "QUEUED" }).state, "RUNNING");
});

test("idempotency: same key and input replays; same key with different input conflicts", () => {
  const { journal } = setup();
  const input = { projectId: "p", branch: "axis/x", baseRef: "main", baseSha: SHA, createdBy: "user" as const, idempotencyKey: KEY1 };
  const first = journal.createWorkspace(input);
  const second = journal.createWorkspace(input);
  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.equal(second.value.id, first.value.id);
  assert.equal(journal.listWorkspaces().length, 1);
  assert.throws(() => journal.createWorkspace({ ...input, branch: "axis/other" }), code("E_IDEMPOTENCY_CONFLICT"));

  journal.transitionWorkspace(first.value.id, "READY");
  const r1 = journal.createRun({ workspaceId: first.value.id, kind: "cli", idempotencyKey: KEY2 , createdBy: "user" });
  const r2 = journal.createRun({ workspaceId: first.value.id, kind: "cli", idempotencyKey: KEY2 , createdBy: "user" });
  assert.equal(r2.value.id, r1.value.id);
  assert.equal(r2.replayed, true);
  assert.throws(() => journal.createRun({ workspaceId: first.value.id, kind: "composer", idempotencyKey: KEY2 , createdBy: "user" }), code("E_IDEMPOTENCY_CONFLICT"));
  assert.equal(journal.listRuns().length, 1);
});

test("keys are scoped per operation, and must be UUIDv4", () => {
  const { journal } = setup();
  const ws = journal.createWorkspace({ projectId: "p", branch: "b", baseRef: "main", baseSha: SHA, createdBy: "user", idempotencyKey: KEY1 }).value;
  journal.transitionWorkspace(ws.id, "READY");
  // Same key string used for a different operation is independent.
  assert.equal(journal.createRun({ workspaceId: ws.id, kind: "cli", idempotencyKey: KEY1 , createdBy: "user" }).replayed, false);
  assert.throws(() => journal.createRun({ workspaceId: ws.id, kind: "cli", idempotencyKey: "not-a-uuid", createdBy: "user" }), code("E_INVALID_ARGUMENT"));
});

test("input validation rejects unknown keys, bad actors, bad shas and free-text reasons", () => {
  const { journal } = setup();
  const base = { projectId: "p", branch: "b", baseRef: "main", baseSha: SHA, createdBy: "user" as const };
  assert.throws(() => journal.createWorkspace({ ...base, baseSha: "zzz" }), code("E_INVALID_ARGUMENT"));
  assert.throws(() => journal.createWorkspace({ ...base, createdBy: "root" as never }), code("E_INVALID_ARGUMENT"));
  assert.throws(() => journal.createWorkspace({ ...base, extra: 1 } as never), code("E_INVALID_ARGUMENT"));
  assert.throws(() => journal.createWorkspace({ ...base, branch: "a\nb" }), code("E_INVALID_ARGUMENT"));
  const ws = readyWorkspace(journal);
  const run = journal.createRun({ workspaceId: ws.id, kind: "cli", createdBy: "user" }).value;
  assert.throws(() => journal.transitionRun(run.id, "RUNNING", { reason: `failed with ${FAKE.anthropic}` }), code("E_INVALID_ARGUMENT"));
  assert.equal(journal.getRun(run.id)?.state, "QUEUED");
});

test("validation errors never echo the offending value", () => {
  const { journal } = setup();
  try {
    journal.createWorkspace({ projectId: FAKE.password, branch: "b", baseRef: "main", baseSha: "bad", createdBy: "user" });
    assert.fail("should have thrown");
  } catch (e) {
    assert.ok(e instanceof AxisError);
    assert.ok(!e.message.includes(FAKE.password));
    assert.match(e.message, /baseSha/);
  }
});

test("recovery policy: RUNNING becomes BLOCKED; QUEUED, REVIEWING and BLOCKED are untouched; audit events written", () => {
  const { journal, audit } = setup();
  const ws = readyWorkspace(journal);
  const mk = (kind: "cli" | "composer", ...path: RunState[]) => {
    const run = journal.createRun({ workspaceId: ws.id, kind , createdBy: "user" }).value;
    for (const s of path) journal.transitionRun(run.id, s, { actor: USER });
    return run.id;
  };
  const queued = mk("cli");
  const running1 = mk("cli", "RUNNING");
  const running2 = mk("composer", "RUNNING");
  const reviewing = mk("cli", "RUNNING", "REVIEWING");
  const blocked = mk("composer", "RUNNING", "BLOCKED");
  const done = mk("cli", "RUNNING", "REVIEWING", "COMPLETED");

  const report = journal.recover(LOCK);
  assert.deepEqual([...report.runsInterrupted].sort(), [running1, running2].sort());
  assert.deepEqual([...report.runsLeftAlone].sort(), [queued, reviewing, blocked].sort());

  for (const id of [running1, running2]) {
    const run = journal.getRun(id);
    assert.equal(run?.state, "BLOCKED");
    assert.equal(run?.reason, RESTART_REASON);
    assert.deepEqual(journal.transitions("run", id).at(-1)?.actor, "daemon");
  }
  assert.equal(journal.getRun(queued)?.state, "QUEUED");
  assert.equal(journal.getRun(reviewing)?.state, "REVIEWING");
  assert.equal(journal.getRun(blocked)?.state, "BLOCKED");
  assert.equal(journal.getRun(done)?.state, "COMPLETED");

  const events = audit.list();
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((e) => [e.actor, e.action, e.outcome]), [
    ["daemon", "journal.recovery", "success"],
    ["daemon", "journal.recovery", "success"],
  ]);
  assert.ok(events.some((e) => e.target === `run:${running1}`));
  assert.equal(audit.verify().ok, true);

  // A blocked run can be retried or cancelled by the user afterwards.
  assert.equal(journal.transitionRun(running1, "QUEUED", { actor: "user", reason: "USER_RETRY" }).state, "QUEUED");
  assert.equal(journal.transitionRun(running2, "CANCELLED", { actor: "user" }).state, "CANCELLED");

  // Idempotent: nothing left to do.
  const again = journal.recover(LOCK);
  assert.deepEqual([again.runsInterrupted, again.workspacesFailed, again.workspacesNeedingReconcile], [[], [], []]);
  assert.equal(audit.list().length, 2);
});

test("recovery policy for workspaces: CREATING fails, REMOVING is reported and kept", () => {
  const { journal, audit } = setup();
  const creating = journal.createWorkspace({ projectId: "p", branch: "a", baseRef: "main", baseSha: SHA, createdBy: "user" }).value;
  const removing = readyWorkspace(journal);
  journal.transitionWorkspace(removing.id, "REMOVING");
  const ready = readyWorkspace(journal);

  const report = journal.recover(LOCK);
  assert.deepEqual(report.workspacesFailed, [creating.id]);
  assert.deepEqual(report.workspacesNeedingReconcile, [removing.id]);
  assert.equal(journal.getWorkspace(creating.id)?.state, "FAILED");
  assert.equal(journal.getWorkspace(removing.id)?.state, "REMOVING");
  assert.equal(journal.getWorkspace(ready.id)?.state, "READY");
  assert.equal(audit.list().length, 2);
  assert.equal(audit.verify().ok, true);
});

test("a failing audit append rolls back the whole recovery (all or nothing)", () => {
  const db = openDatabase(":memory:");
  const real = new AuditLog(db);
  let calls = 0;
  const flaky = real;
  const realAppend = real.append.bind(real);
  flaky.append = (input) => {
    if (++calls === 2) throw new AxisError("E_INTERNAL", "disk full");
    return realAppend(input);
  };
  const journal = Journal.open(db, { audit: flaky });
  const ws = readyWorkspace(journal);
  for (let i = 0; i < 3; i++) {
    const r = journal.createRun({ workspaceId: ws.id, kind: "cli", createdBy: "user" }).value;
    journal.transitionRun(r.id, "RUNNING");
  }
  assert.throws(() => journal.recover(LOCK), code("E_INTERNAL"));
  assert.equal(journal.listRuns({ states: ["RUNNING"] }).length, 3);
  assert.equal(real.head(), null);
});

test("open refuses an audit log bound to a different database handle", () => {
  const journalDb = openDatabase(":memory:");
  const otherDb = openDatabase(":memory:");
  assert.throws(() => Journal.open(journalDb, { audit: new AuditLog(otherDb) }), code("E_INTERNAL"));
  // Same path, separate connections is still a different handle.
  const a = openDatabase(":memory:");
  assert.throws(() => Journal.open(a, { audit: new AuditLog(openDatabase(":memory:")) }), code("E_INTERNAL"));
  // The matching handle is accepted and nothing was migrated by the failed attempts.
  assert.equal(schemaVersion(journalDb, "journal"), 0);
  Journal.open(a, { audit: new AuditLog(a) });
});

// ---- review regressions (S6 to S9, N6) ----

test("S6: createdBy is part of the run idempotency hash and scope, so attribution cannot be merged", () => {
  const { journal } = setup();
  const ws = readyWorkspace(journal);
  const first = journal.createRun({ workspaceId: ws.id, kind: "cli", createdBy: "user", idempotencyKey: KEY1 });
  const other = journal.createRun({ workspaceId: ws.id, kind: "cli", createdBy: "agent:evil", idempotencyKey: KEY1 });
  assert.equal(other.replayed, false);
  assert.notEqual(other.value.id, first.value.id);
  const again = journal.createRun({ workspaceId: ws.id, kind: "cli", createdBy: "user", idempotencyKey: KEY1 });
  assert.equal(again.replayed, true);
  assert.equal(again.value.id, first.value.id);
  assert.throws(() => journal.createRun({ workspaceId: ws.id, kind: "composer", createdBy: "user", idempotencyKey: KEY1 }), code("E_IDEMPOTENCY_CONFLICT"));
});

test("S7: a workspace cannot start removal while any run is not finished", () => {
  const { journal } = setup();
  const ws = readyWorkspace(journal);
  const run = journal.createRun({ workspaceId: ws.id, kind: "cli", createdBy: "user" }).value;
  journal.transitionRun(run.id, "RUNNING");
  assert.throws(() => journal.transitionWorkspace(ws.id, "REMOVING"), code("E_CONFLICT"));
  journal.transitionRun(run.id, "CANCELLED");
  assert.equal(journal.transitionWorkspace(ws.id, "REMOVING").state, "REMOVING");
});

test("S8: a run cannot reach COMPLETED without passing REVIEWING", () => {
  const { journal } = setup();
  const ws = readyWorkspace(journal);
  const run = journal.createRun({ workspaceId: ws.id, kind: "cli", createdBy: "user" }).value;
  journal.transitionRun(run.id, "RUNNING");
  assert.throws(() => journal.transitionRun(run.id, "COMPLETED", { actor: USER }), code("E_CONFLICT"));
  assert.ok(!RUN_TRANSITIONS.RUNNING.includes("COMPLETED"));
  journal.transitionRun(run.id, "REVIEWING");
  assert.equal(journal.transitionRun(run.id, "COMPLETED", { exitCode: 0, actor: USER }).state, "COMPLETED");
});

test("S9: lone surrogates in journal strings are rejected", () => {
  const { journal } = setup();
  assert.throws(
    () => journal.createWorkspace({ projectId: "p\uD800", branch: "b", baseRef: "main", baseSha: SHA, createdBy: "user" }),
    code("E_INVALID_ARGUMENT"),
  );
});

test("N6: expectedFrom and target states are constrained to the state enums and never echoed", () => {
  const { journal } = setup();
  const ws = readyWorkspace(journal);
  const big = "Z".repeat(5000);
  for (const call of [
    () => journal.transitionWorkspace(ws.id, "REMOVING", { expectedFrom: big }),
    () => journal.transitionWorkspace(ws.id, big as never),
    () => journal.transitionRun(big, big as never),
  ]) {
    assert.throws(call, (e: unknown) => e instanceof AxisError && e.code === "E_INVALID_ARGUMENT" && !JSON.stringify([e.message, e.detail]).includes("ZZZZ"));
  }
});

test("S11: recovery reports a REMOVING workspace every time but audits it once", () => {
  const { journal, audit } = setup();
  const ws = readyWorkspace(journal);
  journal.transitionWorkspace(ws.id, "REMOVING");
  assert.deepEqual(journal.recover(LOCK).workspacesNeedingReconcile, [ws.id]);
  const seq = audit.head()?.seq;
  assert.deepEqual(journal.recover(LOCK).workspacesNeedingReconcile, [ws.id]);
  assert.deepEqual(journal.recover(LOCK).workspacesNeedingReconcile, [ws.id]);
  assert.equal(audit.head()?.seq, seq);
  const released = acquireInstanceLock(mkdtempSync(join(tmpdir(), "axis-journal-rel-")));
  released.release();
  assert.throws(() => journal.recover(released), code("E_CONFLICT"));
  assert.throws(() => journal.recover(undefined as never), code("E_INVALID_ARGUMENT"));
});

// ---- NEW-D / S10: recover() needs a genuine lock for this database's directory ----

test("NEW-D: a literal lock, a lock for another directory and a released lock are refused; the live run is untouched", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "axis-j-data-"));
  const otherDir = mkdtempSync(join(tmpdir(), "axis-j-other-"));
  try {
    const db = openDatabase(join(dataDir, "j.db"));
    const audit = new AuditLog(db);
    const journal = Journal.open(db, { audit });
    const ws = readyWorkspace(journal);
    const run = journal.createRun({ workspaceId: ws.id, kind: "cli", createdBy: "user" }).value.id;
    journal.transitionRun(run, "RUNNING"); // a live daemon's run

    const literal = { path: join(dataDir, "axis.lock"), held: true, release() {} };
    const unrelated = acquireInstanceLock(otherDir);
    assert.throws(() => journal.recover(literal as never), code("E_INVALID_ARGUMENT"));
    assert.throws(() => journal.recover(unrelated), code("E_INVALID_ARGUMENT"));
    assert.equal(journal.getRun(run)?.state, "RUNNING", "a refused recovery must not touch the live run");
    unrelated.release();

    const real = acquireInstanceLock(dataDir);
    assert.deepEqual(journal.recover(real).runsInterrupted, [run]);
    real.release();
    assert.throws(() => journal.recover(real), code("E_CONFLICT"));
    db.close();
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(otherDir, { recursive: true, force: true });
  }
});

// ---- NEW-I / judgement (c): approval is a human act ----

test("NEW-I: only the user completes a run in review; an agent (even its own author), the daemon and no actor are denied", () => {
  const { journal, audit } = setup();
  const ws = readyWorkspace(journal);
  const run = journal.createRun({ workspaceId: ws.id, kind: "composer", createdBy: "agent:w1" }).value.id;
  journal.transitionRun(run, "RUNNING", { actor: "agent:w1" });
  journal.transitionRun(run, "REVIEWING", { actor: "agent:w1" });
  const before = audit.head()?.seq;
  for (const opts of [{ actor: "agent:w1" as const }, { actor: "agent:other" as const }, { actor: "daemon" as const }, {}]) {
    assert.throws(() => journal.transitionRun(run, "COMPLETED", opts), code("E_POLICY_DENIED"));
    assert.equal(journal.getRun(run)?.state, "REVIEWING");
  }
  assert.equal(audit.head()?.seq, before, "a denied approval writes nothing");
  // Rejection and cancellation stay available to the agent side; approval does not.
  assert.equal(journal.transitionRun(run, "COMPLETED", { actor: USER }).state, "COMPLETED");
  assert.equal(journal.transitions("run", run).at(-1)?.actor, "user");
});

test("NEW-E: createRun needs a principal; there is no default to the user", () => {
  const { journal } = setup();
  const ws = readyWorkspace(journal);
  assert.throws(() => journal.createRun({ workspaceId: ws.id, kind: "cli" } as never), code("E_INVALID_ARGUMENT"));
  assert.throws(() => journal.createRun({ workspaceId: ws.id, kind: "cli", createdBy: "someone" } as never), code("E_INVALID_ARGUMENT"));
});

test("NEW-H: listRuns reports a bad state as E_INVALID_ARGUMENT, never a raw ZodError", () => {
  const { journal } = setup();
  for (const states of [["NOPE"], "RUNNING", [5], Array(20).fill("QUEUED")]) {
    assert.throws(() => journal.listRuns({ states: states as never }), code("E_INVALID_ARGUMENT"));
  }
  assert.deepEqual(journal.listRuns({ states: [] }), []);
});

test("the shipped journal migration is pinned by hash (add a new migration instead of editing it)", async () => {
  const { createHash } = await import("node:crypto");
  const { JOURNAL_MIGRATIONS } = await import("../src/index.js");
  assert.equal(JOURNAL_MIGRATIONS.length, 2);
  assert.equal(createHash("sha256").update(JOURNAL_MIGRATIONS[0]?.sql ?? "").digest("hex"), "92332f71a375b32c59a45d0059e20ffd5a90090032b72c567ac0698c5db4d2e9");
  assert.equal(createHash("sha256").update(JOURNAL_MIGRATIONS[1]?.sql ?? "").digest("hex"), "9302852a810e1b6069f421ebb3af4b5493bbeb28753da79d24ed832e2571d0bf");
});

// ---- the user principal is a brand the daemon mints, not a value a caller can assert ----

test("principal: a string, a literal, a prototype lookalike and a clone cannot approve; the minted principal can", async () => {
  const { UserPrincipal } = await import("../src/principal.js");
  const { journal } = setup();
  const ws = readyWorkspace(journal);
  const run = journal.createRun({ workspaceId: ws.id, kind: "composer", createdBy: "agent:w1" }).value.id;
  journal.transitionRun(run, "RUNNING");
  journal.transitionRun(run, "REVIEWING");
  const forged: unknown[] = [
    "user",
    { kind: "user" },
    { actor: "user" },
    Object.create(UserPrincipal.prototype),
    structuredClone(USER),
    JSON.parse(JSON.stringify(USER)),
    { ...USER },
    Object.defineProperty(Object.create(UserPrincipal.prototype), "actor", { value: "user", enumerable: true }),
  ];
  for (const actor of forged) {
    assert.throws(() => journal.transitionRun(run, "COMPLETED", { actor } as never), code("E_POLICY_DENIED"), JSON.stringify(actor));
    assert.equal(journal.getRun(run)?.state, "REVIEWING");
  }
  assert.throws(() => new UserPrincipal(Symbol("guess")), code("E_POLICY_DENIED"));
  assert.equal(UserPrincipal.is(USER), true);
  assert.equal(journal.transitionRun(run, "COMPLETED", { actor: USER }).state, "COMPLETED");
  assert.equal(journal.transitions("run", run).at(-1)?.actor, "user", "the principal is recorded as the user");
});

test("principal: the package root does not export a way to mint one; the daemon-principal subpath does", async () => {
  const root = (await import("@axis/journal")) as Record<string, unknown>;
  for (const name of ["userPrincipal", "UserPrincipal", "MINT"]) assert.equal(name in root, false, name);
  // The test cannot import the restricted subpath by name (the import-allowlist test forbids it outside the daemon),
  // so check what the package's exports map points at, and exercise that module through its relative path.
  const { readFileSync, existsSync } = await import("node:fs");
  const pkgDir = fileURLToPath(new URL("../../", import.meta.url));
  const exportsMap = (JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as { exports: Record<string, { default: string }> }).exports;
  assert.deepEqual(Object.keys(exportsMap).sort(), [".", "./daemon-principal"]);
  assert.equal(existsSync(join(pkgDir, exportsMap["./daemon-principal"]?.default ?? "missing")), true);
  assert.deepEqual(Object.keys(daemonPrincipal), ["userPrincipal"]);
  const { UserPrincipal } = await import("../src/principal.js");
  assert.equal(UserPrincipal.is(daemonPrincipal.userPrincipal()), true);
});

test("principal: any other object as an actor is also denied on a workspace transition", () => {
  const { journal } = setup();
  const ws = readyWorkspace(journal);
  assert.throws(() => journal.transitionWorkspace(ws.id, "REMOVING", { actor: { actor: "user" } } as never), code("E_POLICY_DENIED"));
  assert.equal(journal.transitionWorkspace(ws.id, "REMOVING", { actor: USER }).state, "REMOVING");
});
