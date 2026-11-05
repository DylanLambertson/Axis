// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Regression tests for the independent review of the first version: each fails on that version.
import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { setFlagsFromString } from "node:v8";
import { AxisError } from "@axis/audit";
import { DISCLOSURE_VERSION, RUN_COPY } from "../src/copy.js";
import { RingBuffer } from "../src/ring.js";
import { FakeHandle, flush, harness } from "./helpers.js";

const code = (c: string) => (e: unknown) => e instanceof AxisError && e.code === c;
const payload = (r: { payload: unknown } | undefined) => r?.payload as Record<string, unknown>;

test("B1: the environment disclosure is true: editor variables are removed, tokens in the login environment are not", async () => {
  const h = harness({
    env: { PATH: "/usr/bin", HOME: "/home/u", GITHUB_TOKEN: "token-value-one", ANTHROPIC_API_KEY: "key-value-one", VSCODE_NONCE: "nonce-one", GIT_ASKPASS: "/x", SSH_AUTH_SOCK: "/tmp/s" },
  });
  await h.start(h.workspace());
  const env = h.pty.spawns[0]?.env as Record<string, string>;
  assert.equal(env["GITHUB_TOKEN"], "token-value-one", "tokens pass through");
  assert.equal(env["ANTHROPIC_API_KEY"], "key-value-one");
  assert.equal(env["VSCODE_NONCE"], undefined);
  assert.equal(env["GIT_ASKPASS"], undefined);
  const text = RUN_COPY.launchDialog.environment;
  assert.match(text, /passed through/);
  assert.match(text, /including any tokens/);
  assert.doesNotMatch(text, /tokens are removed|tokens .{0,20}removed/i, "the copy must not claim a protection the launch does not give");
  assert.equal(DISCLOSURE_VERSION, 2, "the wording changed, so the version moved");
});

test("B2: a journal that throws on every read never crashes the daemon or leaks its error", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown): void => void unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  try {
    const h = harness();
    const w = h.workspace();
    const { run, handle } = await h.running(w);
    h.supervisor.onChange(() => {});
    const j = h.journal as unknown as Record<string, unknown>;
    for (const m of ["getRun", "getWorkspace", "listRuns", "createRun", "recover"]) j[m] = () => { throw new Error("SQLITE_BUSY: database is locked /secret/db/path"); };
    handle.emitExit();
    await flush(12);
    assert.equal(unhandled.length, 0, "no unhandled rejection");
    assert.equal(h.supervisor.activeCount, 0, "the slot is still freed");
    for (const call of [() => h.supervisor.get(run.runId), () => h.supervisor.list(), () => h.supervisor.workspaceStatus(w.id)]) {
      assert.throws(call, (e: unknown) => e instanceof AxisError && e.code === "E_UNAVAILABLE" && !/SQLITE|secret/.test(e.message));
    }
    await assert.rejects(h.start(w), (e: unknown) => e instanceof AxisError && !/SQLITE|secret/.test(e.message) && ["E_INTERNAL", "E_UNAVAILABLE"].includes(e.code));
    assert.ok(h.errors.every((x) => !/SQLITE|secret/.test(x)), "reports carry labels and codes only");
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("B2: a journal read that fails while the start path releases the slot keeps the closed-set error", async () => {
  const h = harness();
  h.pty.mode = "reject";
  h.supervisor.onChange(() => {});
  const w = h.workspace();
  const real = h.journal.getRun.bind(h.journal);
  let broken = false;
  h.journal.getRun = (id: string) => {
    if (broken) throw new Error("SQLITE_BUSY raw");
    return real(id);
  };
  h.supervisor.onChange((e) => {
    if (e.state === "CANCELLED") broken = true;
  });
  await assert.rejects(h.start(w), (e: unknown) => e instanceof AxisError && e.code === "E_UNAVAILABLE" && !/SQLITE/.test(e.message));
  assert.equal(h.supervisor.activeCount, 0);
});

test("S1: an exit seen during subscription followed by a throwing onData still frees the slot", async () => {
  const h = harness();
  h.pty.configure = (hd: FakeHandle) => {
    hd.exitDuringSubscribe = { exitCode: 1, signal: null };
    hd.throwOnSubscribe = "data";
  };
  const w = h.workspace();
  await assert.rejects(h.start(w), code("E_UNAVAILABLE"));
  await flush(12);
  assert.equal(h.supervisor.activeCount, 0);
  assert.equal(h.supervisor.isCliRunActive(w.tree), false, "commit is not refused until restart");
  assert.equal(h.clock.pending, 0);
});

test("S2: an unconfirmed kill shows as stopping, keeps the workspace active, and a second stop sends SIGKILL again", async () => {
  const h = harness({ limits: { graceMs: 100, killTimeoutMs: 100 } });
  const w = h.workspace();
  const { run, handle } = await h.running(w);
  h.supervisor.stop(run.runId, "user");
  await h.clock.advance(400);
  const stuck = h.supervisor.get(run.runId);
  assert.equal(stuck.reason, "KILL_UNCONFIRMED");
  assert.equal(stuck.status, "stopping");
  assert.equal(stuck.live, true);
  assert.equal(h.supervisor.workspaceStatus(w.id), "running", "not idle while a process may live");
  const before = handle.kills.length;
  h.supervisor.stop(run.runId, "user");
  assert.equal(handle.kills.length, before + 1);
  assert.equal(handle.kills[handle.kills.length - 1], "SIGKILL");
  handle.emitExit({ exitCode: null, signal: "SIGKILL" });
  await flush();
  assert.equal(h.supervisor.get(run.runId).status, "killed");
  assert.equal(h.supervisor.workspaceStatus(w.id), "idle");
});

test("S2: a hung spawn shows as stopping, not failed", async () => {
  const h = harness({ limits: { startTimeoutMs: 100 } });
  h.pty.mode = "hang";
  const w = h.workspace();
  const started = assert.rejects(h.start(w), code("E_TIMEOUT"));
  await flush();
  await h.clock.advance(100);
  await started;
  assert.equal(h.supervisor.list()[0]?.status, "stopping");
  assert.equal(h.supervisor.workspaceStatus(w.id), "running");
});

test("S3: a failed or timed-out post-run snapshot is unknown, in the audit row and on the summary", async () => {
  for (const mode of ["throw", "hang", "drift", "ok"] as const) {
    const h = harness({ limits: { snapshotTimeoutMs: 100 } });
    h.snapshotter.after_ = mode;
    const { run, handle } = await h.running(h.workspace());
    assert.equal(h.supervisor.get(run.runId).snapshotAfter, "pending");
    handle.emitExit();
    await flush();
    await h.clock.advance(100);
    const row = payload(h.auditRows().find((r) => r.action === "cli_run.exit"));
    const want = { throw: "unknown", hang: "unknown", drift: "drift", ok: "ok" }[mode];
    assert.equal(h.supervisor.get(run.runId).snapshotAfter, want, mode);
    assert.equal(row["drift"], { throw: null, hang: null, drift: true, ok: false }[mode], mode);
  }
});

test("S4: after dispose the guard fails closed even though the process was only signalled", async () => {
  const h = harness();
  const w = h.workspace();
  const { handle } = await h.running(w);
  handle.exitOn = undefined; // ignores SIGKILL
  h.supervisor.dispose();
  assert.equal(h.supervisor.isCliRunActive(w.tree), true);
  assert.equal(h.supervisor.isCliRunActive({ workTree: "/elsewhere", gitDir: "/else/.git" }), true);
});

test("S5: recovery is one-shot and refused after any start", async () => {
  const h = harness();
  const { acquireInstanceLock } = await import("@axis/audit");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "axis-runs-s5-"));
  const lock = acquireInstanceLock(dir);
  try {
    const w = h.workspace();
    const composer = h.journal.createRun({ workspaceId: w.id, kind: "composer", createdBy: "daemon" }).value.id;
    h.journal.transitionRun(composer, "RUNNING");
    await h.start(w).catch(() => {});
    assert.throws(() => h.supervisor.recover(lock), code("E_CONFLICT"));
    assert.equal(h.journal.getRun(composer)?.state, "RUNNING", "a live composer run is not interrupted");
    const fresh = harness();
    fresh.supervisor.recover(lock);
    assert.throws(() => fresh.supervisor.recover(lock), code("E_CONFLICT"));
  } finally {
    lock.release();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S6: a lapsed lease keeps refusing runs, reports itself, and tells the holder", async () => {
  const h = harness();
  const w = h.workspace();
  const lease = h.supervisor.acquireGitOperation(w.tree, { maxMs: 500 });
  await h.clock.advance(500);
  assert.ok(h.errors.includes("lease:E_TIMEOUT"));
  assert.throws(() => lease.assertHeld(), code("E_CONFLICT"));
  await assert.rejects(h.start(w), code("E_CONFLICT"));
  lease.release();
  assert.equal(h.clock.pending, 0);
  await h.start(w);
});

test("S7: a huge chunk does not keep its memory alive in the ring", () => {
  setFlagsFromString("--expose-gc");
  const gc = runInNewContext("gc") as () => void;
  gc();
  const base = process.memoryUsage().heapUsed;
  const rings: RingBuffer[] = [];
  for (let i = 0; i < 20; i++) {
    const r = new RingBuffer(65_536);
    r.append("x".repeat(5_000_000) + String(i));
    rings.push(r);
  }
  gc();
  const grown = process.memoryUsage().heapUsed - base;
  assert.ok(grown < 20 * 1024 * 1024, `retained ${grown} bytes`);
  assert.equal(rings[3]?.length, 65_536);
  assert.ok(rings[3]?.tail(2).endsWith("3"));
});

test("N1/N3/N4: a moved executable or a not-ready workspace refuses the spawn, and plain tail has no escapes", async () => {
  const h = harness();
  const w = h.workspace();
  h.snapshotter.before_ = "hang";
  const started = h.start(w);
  const asserted = assert.rejects(started, code("E_CONFLICT"));
  await flush();
  h.executables.delete("/usr/bin/fakecli");
  h.executables.add("/usr/local/bin/fakecli");
  h.setEnv({ PATH: "/usr/local/bin:/usr/bin", HOME: "/home/u" });
  h.snapshotter.releaseBefore?.();
  await asserted;
  assert.equal(h.pty.spawns.length, 0);

  const h2 = harness();
  const { run, handle } = await h2.running(h2.workspace());
  handle.emitData("\u001b]633;P;Cwd=/etc\u0007hello \u001b[31mred\u001b[0m\u0000 done");
  assert.equal(h2.supervisor.tail(run.runId, 100, { plain: true }), "hello red done");
  assert.ok(h2.supervisor.tail(run.runId, 100).includes("\u001b]633"));
});
