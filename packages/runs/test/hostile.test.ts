// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { AxisError } from "@axis/audit";
import { CLI, FakeHandle, flush, harness } from "./helpers.js";

const code = (c: string) => (e: unknown) => e instanceof AxisError && e.code === c;

test("spawn rejects, throws, or returns garbage: the run fails, the slot is free, nothing leaks", async () => {
  for (const mode of ["reject", "throw", "garbage"] as const) {
    const h = harness();
    h.pty.mode = mode;
    const w = h.workspace();
    await assert.rejects(h.start(w), code("E_UNAVAILABLE"));
    const [run] = h.supervisor.list();
    assert.equal(run?.state, "CANCELLED", mode);
    assert.equal(run?.reason, "SPAWN_FAILED", mode);
    assert.equal(run?.status, "failed", mode);
    assert.equal(h.supervisor.activeCount, 0, mode);
    assert.equal(h.supervisor.isCliRunActive(w.tree), false, mode);
    assert.equal(h.clock.pending, 0, mode);
  }
});

test("a spawn that hangs times out but keeps the slot until the port settles; a late handle is killed", async () => {
  const h = harness({ limits: { startTimeoutMs: 1000, graceMs: 1000 } });
  h.pty.mode = "hang";
  const w = h.workspace();
  const started = h.start(w);
  const asserted = assert.rejects(started, code("E_TIMEOUT"));
  await flush();
  await h.clock.advance(1000);
  await asserted;
  const [run] = h.supervisor.list();
  assert.equal(run?.reason, "SPAWN_TIMEOUT");
  assert.equal(h.supervisor.activeCount, 1, "the slot is held: a process may still appear");
  assert.equal(h.supervisor.isCliRunActive(w.tree), true);
  const late = h.pty.makeHandle();
  h.pty.pending[0]?.resolve(late);
  await flush();
  assert.deepEqual(late.kills, ["SIGINT"]);
  assert.equal(h.supervisor.activeCount, 1, "still held until the process is gone");
  late.emitExit({ exitCode: null, signal: "SIGINT" });
  await flush();
  assert.equal(h.supervisor.activeCount, 0);
  assert.equal(h.supervisor.isCliRunActive(w.tree), false);
  assert.equal(h.supervisor.get(run?.runId ?? "").reason, "SPAWN_TIMEOUT", "the record is not rewritten by the late exit");
  assert.equal(h.clock.pending, 0);
});

test("a hung spawn that later rejects frees the slot", async () => {
  const h = harness({ limits: { startTimeoutMs: 1000 } });
  h.pty.mode = "hang";
  const started = h.start(h.workspace());
  const asserted = assert.rejects(started, code("E_TIMEOUT"));
  await flush();
  await h.clock.advance(1000);
  await asserted;
  h.pty.pending[0]?.reject(new Error("late"));
  await flush();
  assert.equal(h.supervisor.activeCount, 0);
});

test("a handle whose subscription throws is killed and its slot stays held (no exit can be seen)", async () => {
  const h = harness();
  h.pty.configure = (hd: FakeHandle) => void (hd.throwOnSubscribe = "data");
  const w = h.workspace();
  await assert.rejects(h.start(w), code("E_UNAVAILABLE"));
  assert.deepEqual(h.pty.handles[0]?.kills, ["SIGKILL"]);
  assert.equal(h.supervisor.isCliRunActive(w.tree), true);
  assert.equal(h.pty.handles[0]?.listenerCount, 1 - 1 + h.pty.handles[0]!.exitLive.size, "no data listener remains");
});

test("the per-device limit holds under 20 concurrent starts and frees on exit", async () => {
  const h = harness({ limits: { maxConcurrent: 3 } });
  const ws = Array.from({ length: 20 }, () => h.workspace());
  const results = await Promise.allSettled(ws.map((w) => h.start(w)));
  const ok = results.filter((r) => r.status === "fulfilled").length;
  const refused = results.filter((r) => r.status === "rejected" && code("E_BACKPRESSURE")(r.reason)).length;
  assert.equal(ok, 3);
  assert.equal(refused, 17);
  assert.equal(h.pty.spawns.length, 3);
  assert.equal(h.supervisor.activeCount, 3);
  h.pty.handles[0]?.emitExit();
  await flush();
  assert.equal(h.supervisor.activeCount, 2);
  await h.start(ws[19] as (typeof ws)[number]);
  assert.equal(h.supervisor.activeCount, 3);
});

test("a run id the journal hands out twice never spawns a second process", async () => {
  const id = randomUUID();
  const h = harness({ newId: () => id });
  // The first call uses the id for the workspace; every later id is the same value.
  const w = h.workspace();
  const first = await h.start(w);
  assert.equal(first.run.runId, id);
  const w2 = { id: first.run.workspaceId, projectId: w.projectId };
  await assert.rejects(h.start(w2), (e: unknown) => e instanceof AxisError);
  assert.equal(h.pty.spawns.length, 1);
  assert.equal(h.supervisor.get(id).status, "running", "the live run is untouched");
  assert.equal(h.supervisor.activeCount, 1);
});

test("an idempotent replay returns the live run and never a second process; after exit it is a conflict", async () => {
  const h = harness();
  const w = h.workspace();
  const key = randomUUID();
  const a = await h.start(w, { idempotencyKey: key });
  const b = await h.start(w, { idempotencyKey: key });
  assert.equal(b.replayed, true);
  assert.equal(b.run.runId, a.run.runId);
  assert.equal(h.pty.spawns.length, 1);
  assert.equal(h.supervisor.activeCount, 1);
  h.pty.handles[0]?.emitExit();
  await flush();
  await assert.rejects(h.start(w, { idempotencyKey: key }), code("E_CONFLICT"));
  assert.equal(h.pty.spawns.length, 1);
  assert.equal(h.supervisor.activeCount, 0);
});

test("the snapshot before a run: a failure or a hang refuses the launch", async () => {
  for (const mode of ["throw", "hang"] as const) {
    const h = harness({ limits: { snapshotTimeoutMs: 1000 } });
    h.snapshotter.before_ = mode;
    const w = h.workspace();
    const p = h.start(w);
    const asserted = assert.rejects(p, code("E_UNAVAILABLE"));
    await flush();
    await h.clock.advance(1000);
    await asserted;
    assert.equal(h.pty.spawns.length, 0, mode);
    assert.equal(h.supervisor.list()[0]?.reason, "SNAPSHOT_FAILED", mode);
    assert.equal(h.supervisor.activeCount, 0, mode);
    assert.equal(h.clock.pending, 0, mode);
  }
});

test("the snapshot after a run is recorded and never blocks the exit", async () => {
  for (const mode of ["throw", "hang", "drift"] as const) {
    const h = harness({ limits: { snapshotTimeoutMs: 1000 } });
    h.snapshotter.after_ = mode;
    const { run, handle } = await h.running(h.workspace());
    handle.emitExit();
    await flush();
    assert.equal(h.supervisor.get(run.runId).state, "REVIEWING", mode);
    await h.clock.advance(1000);
    assert.equal(h.supervisor.activeCount, 0, mode);
    const row = h.auditRows().find((r) => r.action === "cli_run.exit");
    const expected = { throw: "failed", hang: "timeout", drift: "drift" }[mode];
    assert.equal((row?.payload as Record<string, unknown>)["snapshotAfter"], expected, mode);
    assert.equal(h.clock.pending, 0, mode);
  }
});

test("if the start audit row cannot be written the CLI is not started", async () => {
  const h = harness();
  const real = h.audit.append.bind(h.audit);
  h.audit.append = (e) => {
    if (e.action === "cli_run.start") throw new Error("disk full");
    return real(e);
  };
  await assert.rejects(h.start(h.workspace()), code("E_INTERNAL"));
  assert.equal(h.pty.spawns.length, 0);
  assert.equal(h.supervisor.list()[0]?.reason, "AUDIT_FAILED");
  assert.equal(h.supervisor.activeCount, 0);
});

test("a failed exit transition and a failed exit audit row still release the slot", async () => {
  const h = harness();
  const { run, handle } = await h.running(h.workspace());
  h.journal.transitionRun(run.runId, "BLOCKED"); // someone else moved the row: the guarded transition fails
  const real = h.audit.append.bind(h.audit);
  h.audit.append = (e) => {
    if (e.action === "cli_run.exit") throw new Error("boom");
    return real(e);
  };
  handle.emitExit();
  await flush();
  assert.equal(h.supervisor.activeCount, 0);
  assert.equal(h.clock.pending, 0);
  assert.ok(h.errors.includes("transition:E_CONFLICT") && h.errors.includes("audit:E_INTERNAL"), h.errors.join());
});

test("a flood of output stays bounded in memory and time", async () => {
  const h = harness({ limits: { outputBufferChars: 4096 } });
  const { run, handle } = await h.running(h.workspace());
  const big = "x".repeat(1_000_000);
  const t0 = Date.now();
  for (let i = 0; i < 50; i++) handle.emitData(big); // 50 MB
  for (let i = 0; i < 200_000; i++) handle.emitData(i % 2 ? "ab" : "c"); // many tiny chunks
  assert.ok(Date.now() - t0 < 10_000, "the flood must not be quadratic");
  const s = h.supervisor.get(run.runId);
  assert.equal(s.outputChars, 50_000_000 + 300_000);
  assert.equal(s.outputChars - s.droppedChars, 4096);
  assert.equal(h.supervisor.tail(run.runId, 100_000).length <= 8192, true);
});

test("output is redacted on read, including a secret split across two chunks, and never reaches the audit log", async () => {
  const h = harness();
  const secret = "key-one-value-" + "q7Zp".repeat(4);
  h.redactor.registerSecret(secret);
  const { run, handle } = await h.running(h.workspace());
  handle.emitData(`start ${secret.slice(0, 11)}`);
  handle.emitData(`${secret.slice(11)} end`);
  const tail = h.supervisor.tail(run.runId);
  assert.ok(!tail.includes(secret) && !tail.includes(secret.slice(0, 11)), tail);
  assert.ok(tail.includes("[REDACTED"), tail);
  handle.emitExit();
  await flush();
  const all = JSON.stringify(h.auditRows());
  assert.ok(!all.includes("q7Zp") && !all.includes(secret.slice(0, 11)) && !all.includes("--flag-one") && !all.includes("/home/u"), "audit rows hold counts and ids, not output, arguments or environment values");
  const start = h.auditRows().find((r) => r.action === "cli_run.start");
  assert.equal((start?.payload as Record<string, unknown>)["argCount"], 1);
  assert.equal((start?.payload as Record<string, unknown>)["executable"], "fakecli");
});

test("dispose kills live processes and leaves no timer, listener or slot behind", async () => {
  const h = harness();
  const w = h.workspace();
  const { handle } = await h.running(w);
  const events: string[] = [];
  const d = h.supervisor.onChange((e) => void events.push(e.status));
  assert.ok(h.clock.pending > 0);
  h.supervisor.dispose();
  assert.deepEqual(handle.kills, ["SIGKILL"]);
  assert.equal(handle.listenerCount, 0);
  assert.equal(h.clock.pending, 0);
  assert.equal(h.supervisor.activeCount, 0);
  d.dispose();
  handle.emitExit();
  handle.emitData("late");
  await flush();
  assert.deepEqual(events, [], "no event after dispose");
  await assert.rejects(h.start(w), code("E_UNAVAILABLE"));
  h.supervisor.dispose();
});

test("dispose while a spawn is pending: the wait ends, no timer is left, and a process that arrives later is killed at once", async () => {
  const h = harness();
  h.pty.mode = "hang";
  const w = h.workspace();
  const p = h.start(w);
  const asserted = assert.rejects(p, code("E_UNAVAILABLE"));
  await flush();
  h.supervisor.dispose();
  await asserted;
  assert.equal(h.clock.pending, 0, "the spawn timer went with the run");
  const late = h.pty.makeHandle();
  h.pty.pending[0]?.resolve(late);
  await flush();
  assert.deepEqual(late.kills, ["SIGKILL"]);
  assert.equal(h.supervisor.list()[0]?.state, "QUEUED", "the row is left for recovery to interrupt");
  assert.equal(h.clock.pending, 0);
});

test("an environment source that throws is a refused launch: no process, and no run row left QUEUED", async () => {
  const h = harness();
  const w = h.workspace();
  let calls = 0;
  const real = { PATH: "/usr/bin", HOME: "/home/u" };
  h.setEnv(new Proxy(real, { get: (t, k) => { if (++calls > 1) throw new Error("env gone"); return (t as Record<string | symbol, unknown>)[k]; } }) as never);
  // Every read after the first throws; the first resolve may or may not survive, but nothing may be left half-made.
  await assert.rejects(h.start(w), (e: unknown) => e instanceof AxisError);
  assert.equal(h.pty.spawns.length, 0);
  for (const r of h.supervisor.list()) assert.notEqual(r.state, "QUEUED");
  assert.equal(h.supervisor.activeCount, 0);
  assert.equal(h.clock.pending, 0);
});

test("listeners are bounded and a throwing listener is counted, not fatal", async () => {
  const h = harness();
  const disposables = Array.from({ length: 32 }, () => h.supervisor.onChange(() => {}));
  assert.throws(() => h.supervisor.onChange(() => {}), code("E_BACKPRESSURE"));
  disposables[0]?.dispose();
  h.supervisor.onChange(() => {
    throw new Error("listener bug");
  });
  const { handle } = await h.running(h.workspace());
  assert.ok(h.supervisor.listenerErrors > 0);
  handle.emitExit();
  await flush();
  assert.equal(h.supervisor.activeCount, 0);
});

test("resize reaches a running process and is validated", async () => {
  const h = harness();
  const { run, handle } = await h.running(h.workspace());
  h.supervisor.resize(run.runId, 100, 40);
  assert.deepEqual(handle.resized, [[100, 40]]);
  assert.throws(() => h.supervisor.resize(run.runId, 0, 40), code("E_INVALID_ARGUMENT"));
  assert.throws(() => h.supervisor.resize("nope", 100, 40), code("E_NOT_FOUND"));
  void CLI;
});
