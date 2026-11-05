// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { cliRunsMethods } from "@axis/protocol";
import { createCliRunsHandlers, type CliRunsHandlerDeps } from "../src/index.js";
import { newKey, type Client } from "./approvals-rig.js";
import { START, runsRig, until, type RunsRig } from "./runs-rig.js";
import { createWs as createWsRaw, gitSkipReason } from "./worktrees-rig.js";

const skip = gitSkipReason();
const RUNS = "axis.cli-runs";
const create = async (user: Client): Promise<string> => (await createWsRaw(user, (_m, x) => (assert.equal(x.ok, true, JSON.stringify(x.error)), x))).id;

async function setup(t: TestContext): Promise<{ r: RunsRig; user: Client; id: string }> {
  const r = await runsRig();
  t.after(() => r.cleanup());
  const user = await r.connect();
  return { r, user, id: await create(user) };
}

test("start: a run is created for the workspace, in its worktree, with the journal's project and the connection's window asked of main", { skip }, async (t) => {
  const { r, user, id } = await setup(t);
  const s = await user.call(RUNS, "start", START(id), newKey());
  assert.equal(s.ok, true, JSON.stringify(s.error));
  const run = s.result?.["run"] as Record<string, unknown>;
  assert.equal(s.result?.["replayed"], false);
  assert.equal(run["workspaceId"], id);
  assert.equal(run["agentId"], null);
  assert.ok(cliRunsMethods.start.response.safeParse(s.result).success);
  assert.equal(r.pty.spawns.length, 1);
  assert.equal(r.pty.spawns[0]?.cwd, r.journal.getWorkspace(id)?.worktreePath);
  assert.equal(r.pty.spawns[0]?.argv[0], r.exe);
  const trust = r.asked.find((m) => m["type"] === "trust.check");
  assert.deepEqual({ w: trust?.["windowId"], ws: trust?.["workspaceId"], p: trust?.["projectId"] }, { w: "win-1", ws: id, p: r.projectId });
  assert.equal(r.asked[0]?.["type"], "settings.get", "the CLI entry comes from main's user-scope setting");
  assert.equal(r.asked[0]?.["key"], "axis.cliAgents");
  assert.ok(r.db.prepare("SELECT 1 FROM audit_events WHERE action = 'cli_run.start'").get());
});

test("start: main's refusal, or its silence, refuses the start before any run exists (no attestation, no spawn)", { skip }, async (t) => {
  const { r, user, id } = await setup(t);
  r.answers.trust = false;
  const no = await user.call(RUNS, "start", START(id), newKey());
  assert.equal(no.error?.code, "E_CONFLICT");
  assert.equal(no.error?.details?.["reason"], "untrusted");
  r.answers.trust = "silent";
  const silent = await user.call(RUNS, "start", START(id), newKey());
  assert.equal(silent.ok, false);
  assert.equal(silent.error?.details?.["reason"], "untrusted");
  assert.equal(r.pty.spawns.length, 0);
  assert.equal(r.journal.listRuns({ workspaceId: id }).length, 0, "no run row was made");
  assert.equal(r.control.stats().pending, 0, "no request is left waiting");
});

test("start: an unknown or unset CLI id is E_NOT_FOUND and main is never asked about trust", { skip }, async (t) => {
  const { r, user, id } = await setup(t);
  const unknown = await user.call(RUNS, "start", START(id, "other"), newKey());
  assert.equal(unknown.error?.code, "E_NOT_FOUND");
  assert.equal(unknown.error?.details?.["reason"], "agent_unknown");
  r.answers.agents = null;
  const unset = await user.call(RUNS, "start", START(id), newKey());
  assert.equal(unset.error?.details?.["reason"], "agent_unknown");
  assert.equal(r.asked.some((m) => m["type"] === "trust.check"), false);
  assert.equal(r.pty.spawns.length, 0);
});

test("start: a command line in the payload is refused by the contract, and an invalid entry in the setting is dropped", { skip }, async (t) => {
  const { r, user, id } = await setup(t);
  const smuggled = await user.call(RUNS, "start", { ...START(id), command: ["/bin/sh", "-c", "true"] }, newKey());
  assert.equal(smuggled.error?.code, "E_INVALID_ARGUMENT");
  r.answers.agents = [{ id: "fake", label: "Fake", command: ["relative/dir/cli"], args: [] }];
  const bad = await user.call(RUNS, "start", START(id), newKey());
  assert.equal(bad.error?.details?.["reason"], "agent_unknown");
  assert.equal(r.pty.spawns.length, 0);
});

test("start: the same key replays the same run and spawns once; a retry after a refused launch spawns nothing", { skip }, async (t) => {
  const { r, user, id } = await setup(t);
  const key = newKey();
  const a = await user.call(RUNS, "start", START(id), key);
  const b = await user.call(RUNS, "start", START(id), key);
  assert.equal(a.ok && b.ok, true);
  assert.deepEqual(b.result, a.result);
  assert.equal(r.pty.spawns.length, 1);
  assert.equal(r.journal.listRuns({ workspaceId: id }).length, 1);

  // A launch that fails after the run row exists: the retry with the same key must not make a second run.
  const { id: other } = { id: await create(user) };
  r.snapshots.failBefore = true;
  const retryKey = newKey();
  const failed = await user.call(RUNS, "start", START(other), retryKey);
  assert.equal(failed.error?.code, "E_UNAVAILABLE");
  r.snapshots.failBefore = false;
  const retry = await user.call(RUNS, "start", START(other), retryKey);
  assert.equal(retry.ok, false);
  assert.equal(retry.error?.code, "E_CONFLICT");
  assert.equal(r.pty.spawns.length, 1, "the retry started no process");
  assert.equal(r.journal.listRuns({ workspaceId: other }).length, 1, "and made no second run");
});

test("start: the answers carry no path, executable or command line", { skip }, async (t) => {
  const { r, user, id } = await setup(t);
  // An executable the host cannot find: the supervisor refuses with its own text, which must not reach the wire.
  r.answers.agents = [{ id: "fake", label: "Fake", command: [r.exe + "-missing"], args: [] }];
  const s = await user.call(RUNS, "start", START(id), newKey());
  assert.equal(s.ok, false);
  const text = JSON.stringify(s);
  for (const secret of [r.tmp, "fakecli", "wt-root"]) assert.equal(text.includes(secret), false, secret);
  assert.equal(s.error?.details?.["reason"], "executable_not_found");
});

test("stop, get and list: ids only, the newest first bound, unknown runs are E_NOT_FOUND", { skip }, async (t) => {
  const { r, user, id } = await setup(t);
  const s = await user.call(RUNS, "start", START(id), newKey());
  const runId = String((s.result?.["run"] as Record<string, unknown>)["runId"]);
  const got = await user.call(RUNS, "get", { runId });
  assert.equal(got.ok, true, JSON.stringify(got.error));
  assert.equal((got.result?.["run"] as Record<string, unknown>)["runId"], runId);
  const list = await user.call(RUNS, "list", { workspaceId: id, limit: 500 });
  assert.equal(list.ok, true, JSON.stringify(list.error));
  assert.equal((list.result?.["runs"] as unknown[]).length, 1);
  assert.equal(((await user.call(RUNS, "list", {})).result?.["runs"] as unknown[]).length, 1);
  const stopped = await user.call(RUNS, "stop", { runId }, newKey());
  assert.equal(stopped.ok, true, JSON.stringify(stopped.error));
  assert.deepEqual(r.pty.handles[0]?.kills.slice(0, 1), ["SIGINT"]);
  r.pty.handles[0]?.exit(null, "SIGINT");
  await until(() => r.runs.service.get(runId).state === "CANCELLED");
  const missing = "00000000-0000-4000-8000-000000000001";
  for (const [method, payload] of [["get", { runId: missing }], ["stop", { runId: missing }]] as const) {
    const m = await user.call(RUNS, method, payload, method === "stop" ? newKey() : undefined);
    assert.equal(m.error?.code, "E_NOT_FOUND", method);
  }
});

test("handlers: only the user's own connection works with runs; a flagged workspace refuses start but never stop; a cancelled call does nothing", { skip }, async (t) => {
  const { r, id } = await setup(t);
  const calls: string[] = [];
  const deps: CliRunsHandlerDeps = {
    ...r.handlerDeps,
    service: { ...r.handlerDeps.service, start: () => (calls.push("start"), Promise.reject(new Error("unreachable"))), stop: () => (calls.push("stop"), r.runs.service.get("x")) },
    needsAttention: (w) => w === id,
  };
  const h = createCliRunsHandlers(deps);
  const ctx = (actor: string, over: Record<string, unknown> = {}) =>
    ({ identity: { actor, connectionId: "c".repeat(22), windowId: "win-1", actorId: "a", trusted: true, clientKind: "desktop" }, requestId: "q", correlationId: "k", signal: new AbortController().signal, ...over }) as never;
  for (const actor of ["agent:x", "daemon"]) {
    for (const method of ["start", "stop", "get", "list"] as const) {
      await assert.rejects(Promise.resolve(h[method](ctx(actor), { workspaceId: id, agentId: "fake", runId: "x" } as never)), (e: { code?: string }) => e.code === "E_NOT_FOUND", `${actor} ${method}`);
    }
  }
  await assert.rejects(Promise.resolve(h.start(ctx("user"), START(id) as never)), (e: { code?: string; details?: { reason?: string } }) => e.code === "E_UNAVAILABLE" && e.details?.reason === "needs_attention");
  await assert.rejects(Promise.resolve(h.stop(ctx("user"), { runId: "x" } as never)), (e: { code?: string }) => e.code === "E_NOT_FOUND");
  assert.deepEqual(calls, ["stop"], "stop reached the service; start never did");
  const gone = new AbortController();
  gone.abort();
  await assert.rejects(Promise.resolve(h.start(ctx("user", { signal: gone.signal }), START(id) as never)), (e: { code?: string }) => e.code === "E_CANCELLED");
  assert.equal(r.asked.length, 0, "a cancelled start asks main nothing");
});
