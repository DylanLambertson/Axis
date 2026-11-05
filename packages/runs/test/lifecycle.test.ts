// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AxisError } from "@axis/audit";
import { CLI, FakeHandle, firstRunId, flush, harness } from "./helpers.js";

const code = (c: string) => (e: unknown) => e instanceof AxisError && e.code === c;

test("a run goes starting -> running -> finished and every resource is released", async () => {
  const h = harness();
  const w = h.workspace();
  const seen: string[] = [];
  h.supervisor.onChange((e) => void seen.push(`${e.state}/${e.status}`));
  const { run, handle } = await h.running(w);
  assert.equal(run.state, "RUNNING");
  assert.equal(run.status, "running");
  assert.equal(h.supervisor.activeCount, 1);
  assert.equal(h.pty.spawns[0]?.argv[0], "/usr/bin/fakecli");
  assert.deepEqual(h.pty.spawns[0]?.argv.slice(1), ["--flag-one"]);
  assert.equal(h.pty.spawns[0]?.cwd, w.tree.workTree);
  handle.emitExit({ exitCode: 0, signal: null });
  await flush();
  const done = h.supervisor.get(run.runId);
  assert.equal(done.state, "REVIEWING");
  assert.equal(done.status, "finished");
  assert.equal(done.reason, "PROCESS_EXITED");
  assert.equal(h.supervisor.activeCount, 0);
  assert.equal(h.clock.pending, 0, "no timer left behind");
  assert.equal(handle.listenerCount, 0, "no listener left behind");
  assert.ok(seen.includes("QUEUED/starting") && seen.includes("RUNNING/running") && seen.includes("REVIEWING/finished"), seen.join());
  assert.deepEqual(h.snapshotter.log.map((l) => l.split(":")[0]), ["before", "after"]);
  const actions = h.auditRows().map((r) => r.action);
  assert.ok(actions.includes("cli_run.start") && actions.includes("cli_run.exit"));
  assert.equal(h.audit.verify().ok, true);
});

test("exit mapping: non-zero, signal, and an unusable code", async () => {
  const cases: Array<[{ exitCode: number | null; signal: string | null }, string, number | null]> = [
    [{ exitCode: 3, signal: null }, "EXIT_NONZERO", 3],
    [{ exitCode: null, signal: "SIGSEGV" }, "SIGNALLED", null],
    [{ exitCode: 1e9, signal: null }, "EXIT_UNKNOWN", null],
    [{ exitCode: Number.NaN, signal: null }, "EXIT_UNKNOWN", null],
    [{ exitCode: 0, signal: "SIGTERM" }, "SIGNALLED", 0],
  ];
  for (const [exit, reason, exitCode] of cases) {
    const h = harness();
    const { run, handle } = await h.running(h.workspace());
    handle.emitExit(exit);
    await flush();
    const r = h.supervisor.get(run.runId);
    assert.equal(r.state, "FAILED");
    assert.equal(r.reason, reason);
    assert.equal(r.exitCode, exitCode);
    assert.equal(r.status, "failed");
  }
});

test("quiet after the interval, running again on output, and the timer is re-armed lazily", async () => {
  const h = harness({ limits: { quietMs: 5000 } });
  const { run, handle } = await h.running(h.workspace());
  await h.clock.advance(4000);
  assert.equal(h.supervisor.get(run.runId).status, "running");
  handle.emitData("hello");
  await h.clock.advance(4000);
  assert.equal(h.supervisor.get(run.runId).status, "running", "output pushed the quiet point back");
  await h.clock.advance(1500);
  assert.equal(h.supervisor.get(run.runId).status, "quiet");
  const events: string[] = [];
  h.supervisor.onChange((e) => void events.push(e.status));
  handle.emitData("again");
  assert.equal(h.supervisor.get(run.runId).status, "running");
  assert.deepEqual(events, ["running"]);
  assert.equal(h.clock.pending, 1, "one quiet timer per live run");
  handle.emitExit();
  await flush();
  assert.equal(h.clock.pending, 0);
});

test("the launch goes through pty-policy: PTY-5 environment, executable resolved outside the worktree", async () => {
  const h = harness({
    env: { PATH: "/usr/bin", HOME: "/home/u", SSH_AUTH_SOCK: "/tmp/agent.sock", GIT_ASKPASS: "/x", VSCODE_GIT_IPC_HANDLE: "/y", ELECTRON_RUN_AS_NODE: "1", VSCODE_NONCE: "n" },
  });
  const w = h.workspace();
  await h.start(w);
  const env = h.pty.spawns[0]?.env ?? {};
  assert.equal(env["SSH_AUTH_SOCK"], "/tmp/agent.sock");
  for (const k of ["GIT_ASKPASS", "VSCODE_GIT_IPC_HANDLE", "ELECTRON_RUN_AS_NODE", "VSCODE_NONCE"]) assert.equal(k in env, false, k);

  // A planted executable inside the worktree never wins, even when PATH names that directory.
  const h2 = harness({ env: { PATH: "/work/ws-1/bin:/nowhere" }, executables: ["/work/ws-1/bin/fakecli"] });
  const w2 = h2.workspace();
  await assert.rejects(h2.start(w2), code("E_NOT_FOUND"));
  assert.equal(h2.pty.spawns.length, 0);
  assert.equal(h2.journal.listRuns().length, 0, "a refused launch leaves no run row");
  assert.equal(h2.supervisor.activeCount, 0);
  const refused = h2.auditRows().find((r) => r.action === "cli_run.refused");
  assert.equal(refused?.outcome, "denied");
});

test("an invalid CLI definition and a denied pass-through are refused before anything is created", async () => {
  const h = harness();
  const w = h.workspace();
  for (const agent of [{ ...CLI, command: ["../evil"] }, { ...CLI, envPassthrough: ["GIT_ASKPASS"] }, "nope", null, { ...CLI, extra: 1 }]) {
    await assert.rejects(h.start(w, { agent }), code("E_INVALID_ARGUMENT"));
  }
  assert.equal(h.pty.spawns.length, 0);
  assert.equal(h.journal.listRuns().length, 0);
});

test("stop sends SIGINT, SIGTERM, SIGKILL in order and the exit finishes it as stopped", async () => {
  const h = harness({ limits: { graceMs: 1000 } });
  const { run, handle } = await h.running(h.workspace());
  const stopped = h.supervisor.stop(run.runId, "user");
  assert.deepEqual(handle.kills, ["SIGINT"]);
  assert.equal(stopped.state, "RUNNING");
  await h.clock.advance(1000);
  assert.deepEqual(handle.kills, ["SIGINT", "SIGTERM"]);
  await h.clock.advance(1000);
  assert.deepEqual(handle.kills, ["SIGINT", "SIGTERM", "SIGKILL"]);
  handle.emitExit({ exitCode: null, signal: "SIGKILL" });
  await flush();
  const r = h.supervisor.get(run.runId);
  assert.equal(r.state, "CANCELLED");
  assert.equal(r.reason, "USER_KILLED");
  assert.equal(r.status, "killed");
  assert.equal(h.clock.pending, 0, "the ladder's timers are gone");
  assert.equal(h.supervisor.activeCount, 0);
  assert.equal(h.supervisor.stop(run.runId, "user").state, "CANCELLED", "stopping a stopped run is a no-op");
  assert.deepEqual(handle.kills, ["SIGINT", "SIGTERM", "SIGKILL"]);
});

test("an exit in the middle of the ladder stops the ladder", async () => {
  const h = harness({ limits: { graceMs: 1000 } });
  const { run, handle } = await h.running(h.workspace());
  handle.exitOn = "SIGINT";
  h.supervisor.stop(run.runId, "user");
  await flush();
  assert.equal(h.supervisor.get(run.runId).state, "CANCELLED");
  await h.clock.advance(60_000);
  assert.deepEqual(handle.kills, ["SIGINT"]);
  assert.equal(h.clock.pending, 0);
});

test("kill throwing does not stop the ladder and is reported once", async () => {
  const h = harness({ limits: { graceMs: 1000 } });
  const { run, handle } = await h.running(h.workspace());
  handle.throwOnKill = true;
  h.supervisor.stop(run.runId, "user");
  await h.clock.advance(2000);
  assert.deepEqual(handle.kills, ["SIGINT", "SIGTERM", "SIGKILL"]);
  assert.equal(h.errors.filter((e) => e === "kill:E_INTERNAL").length, 1);
});

test("a process that ignores every signal: the kill is recorded as unconfirmed but the run stays active", async () => {
  const h = harness({ limits: { graceMs: 1000, killTimeoutMs: 2000 } });
  const w = h.workspace();
  const { run, handle } = await h.running(w);
  h.supervisor.stop(run.runId, "user");
  await h.clock.advance(1000 + 1000 + 2000);
  const r = h.supervisor.get(run.runId);
  assert.equal(r.state, "CANCELLED");
  assert.equal(r.reason, "KILL_UNCONFIRMED");
  assert.equal(h.supervisor.isCliRunActive(w.tree), true, "commit stays refused while a process may live");
  assert.equal(h.supervisor.activeCount, 1);
  handle.emitExit({ exitCode: null, signal: "SIGKILL" });
  await flush();
  assert.equal(h.supervisor.isCliRunActive(w.tree), false);
  assert.equal(h.supervisor.activeCount, 0);
  assert.equal(h.supervisor.get(run.runId).reason, "KILL_UNCONFIRMED", "a late exit does not rewrite the record");
  assert.equal(h.clock.pending, 0);
});

test("kill during start, before the pty exists: no process is ever spawned", async () => {
  const h = harness();
  h.snapshotter.before_ = "hang";
  const w = h.workspace();
  const id = firstRunId(h);
  const started = h.start(w);
  const runId = await id;
  await flush();
  h.supervisor.stop(runId, "user");
  h.snapshotter.releaseBefore?.();
  await assert.rejects(started, code("E_CANCELLED"));
  assert.equal(h.pty.spawns.length, 0);
  const r = h.supervisor.get(runId);
  assert.equal(r.state, "CANCELLED");
  assert.equal(r.status, "killed");
  assert.equal(h.supervisor.activeCount, 0);
  assert.equal(h.clock.pending, 0);
});

test("kill during start, while spawn is pending: the handle is stopped when it arrives", async () => {
  const h = harness({ limits: { graceMs: 1000 } });
  h.pty.mode = "hang";
  const w = h.workspace();
  const id = firstRunId(h);
  const started = h.start(w);
  const runId = await id;
  await flush();
  assert.equal(h.pty.spawns.length, 1);
  h.supervisor.stop(runId, "user");
  const handle = h.pty.makeHandle();
  h.pty.pending[0]?.resolve(handle);
  await assert.rejects(started, code("E_CANCELLED"));
  assert.deepEqual(handle.kills, ["SIGINT"]);
  assert.equal(h.supervisor.isCliRunActive(w.tree), true, "still active until the exit");
  handle.emitExit({ exitCode: null, signal: "SIGINT" });
  await flush();
  assert.equal(h.supervisor.get(runId).reason, "USER_KILLED");
  assert.equal(h.supervisor.activeCount, 0);
  assert.equal(h.clock.pending, 0);
});

test("an exit delivered synchronously while subscribing is applied after the journal says RUNNING", async () => {
  const h = harness();
  h.pty.configure = (hd: FakeHandle) => void (hd.exitDuringSubscribe = { exitCode: 0, signal: null });
  const { run } = await h.running(h.workspace());
  await flush();
  const r = h.supervisor.get(run.runId);
  assert.equal(r.state, "REVIEWING");
  assert.deepEqual(h.journal.transitions("run", r.runId).map((t) => t.to), ["QUEUED", "RUNNING", "REVIEWING"]);
  assert.equal(h.supervisor.activeCount, 0);
});

test("a second exit event and output after exit change nothing", async () => {
  const h = harness();
  const { run, handle } = await h.running(h.workspace());
  handle.emitData("before");
  handle.emitExit({ exitCode: 0, signal: null });
  handle.emitExit({ exitCode: 1, signal: null });
  handle.emitData("after exit");
  await flush();
  const r = h.supervisor.get(run.runId);
  assert.equal(r.state, "REVIEWING");
  assert.equal(r.exitCode, 0);
  assert.equal(h.journal.transitions("run", run.runId).length, 3);
  assert.equal(h.auditRows().filter((x) => x.action === "cli_run.exit").length, 1);
  assert.throws(() => h.supervisor.tail(run.runId), code("E_NOT_FOUND"));
});
