// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { HandlerContext } from "@axis/daemon";
import { attestedWindow } from "../testing/attested.js";
import { cliEndpointPty, createMessagingBinding, hostMessagingDeps, startCliRun, wireCliEndpoints, type CliEndpoints, type PtyPort, type RelayOut } from "../src/index.js";
import { newKey } from "./approvals-rig.js";
import { runsRig, until } from "./runs-rig.js";
import { switchOnForTests } from "./cli-endpoint-for-tests.js";
import { createWs, gitSkipReason } from "./worktrees-rig.js";

// The CLI endpoint through the REAL run supervisor (not a rig that creates a RUNNING run first): the supervisor spawns while
// the run is QUEUED and moves it to RUNNING only after the spawn returns, so the endpoint is minted while QUEUED. Before
// RUNNING nothing is relayed as the worker (`not_ready`) and the endpoint stays; after, it serves; a failed spawn and the
// run's exit revoke it.

const skip = gitSkipReason();
const ctx = { identity: attestedWindow("win-1", { connectionId: "c".repeat(22), actorId: "a" }), requestId: "q", correlationId: "k", signal: new AbortController().signal, idempotencyKey: newKey() } as unknown as HandlerContext;

async function setup(t: TestContext, spawnHook?: (spec: Parameters<PtyPort["spawn"]>[0], inner: PtyPort) => Promise<Awaited<ReturnType<PtyPort["spawn"]>>>) {
  const holder: { cli?: CliEndpoints | undefined } = {};
  const r = await runsRig({
    wrapPty: (inner) => cliEndpointPty({ spawn: (spec) => (spawnHook === undefined ? inner.spawn(spec) : spawnHook(spec, inner)) }, () => holder.cli),
  });
  t.after(() => r.cleanup());
  const user = await r.connect();
  const ws = (await createWs(user, (_m, x) => (assert.equal(x.ok, true, JSON.stringify(x.error)), x))).id;
  r.journal.agents.create({ id: "w1", projectId: r.projectId, name: "W", launch: { kind: "cli", entryId: "fake" }, homeWorkspaceId: ws, groupId: null });
  r.journal.messages.setAgentSettings("w1", { acceptsFrom: "group", cliMessaging: true, muted: false }); // enabling is still refused: seeded
  switchOnForTests(r.journal.cliEndpoint); // the user's switch (PV-M7 slice 2): the host's lookup and mint read it
  const m = createMessagingBinding(hostMessagingDeps({ journal: r.journal, audit: r.audit, monotonic: () => r.clock.monotonic(), scan: async () => [], logger: undefined, holdsSecret: () => false, enabled: true }));
  const sent: RelayOut[] = [];
  const cleanups: (() => void)[] = [];
  t.after(() => cleanups.forEach((c) => c()));
  holder.cli = wireCliEndpoints(true, { onRelay: () => ({ dispose: () => undefined }), relay: (o: RelayOut) => (sent.push(o), true) }, m.endpoints, cleanups);
  const relay = (msg: Parameters<typeof m.endpoints.relay.onRelay>[1]) => m.endpoints.relay.onRelay(m.endpoints.source, msg);
  const reply = (outs: readonly RelayOut[]) => outs.map((o) => (o.t === "relay-reply" ? JSON.parse(o.frame) : o));
  const start = () => startCliRun(r.handlerDeps, { workspaceId: ws, entryId: "fake", worker: "w1" }, ctx);
  return { r, ws, sent, relay, reply, start, mint: (runId: string) => m.endpoints.relay.mint(runId) };
}

test("through the real supervisor: a worker's CLI run gets its endpoint at spawn; before RUNNING a message answers not_ready and the endpoint stays; after, it serves", { skip }, async (t) => {
  const seen: { open?: unknown[]; endpoint?: string; token?: string } = {};
  const f = await setup(t, async (spec, inner) => {
    const e = spec.messagesEndpoint;
    assert.ok(e !== undefined, "the spawn spec carries the endpoint");
    seen.endpoint = e.endpoint;
    seen.token = e.token;
    seen.open = f.reply(await f.relay({ t: "relay-open", endpoint: e.endpoint, conn: "c0" }));
    return inner.spawn(spec);
  });
  const { run } = (await f.start()) as { run: { runId: string } };
  assert.equal(f.r.journal.getRun(run.runId)?.state, "RUNNING");
  assert.deepEqual(seen.open, [{ ok: false, reason: "not_ready" }], "nothing is relayed before RUNNING");
  assert.equal(f.sent.filter((o) => o.t === "endpoint-close").length, 0, "and the endpoint was not revoked");
  const endpoint = seen.endpoint as string;
  assert.deepEqual(await f.relay({ t: "relay-open", endpoint, conn: "c1" }), []);
  assert.deepEqual(f.reply(await f.relay({ t: "relay-frame", endpoint, conn: "c1", frame: JSON.stringify({ op: "auth", token: seen.token }) })), [{ ok: true, op: "auth" }], "after RUNNING it serves");
  f.r.pty.handles[0]?.exit(0);
  await until(() => f.sent.some((o) => o.t === "endpoint-close"));
  assert.deepEqual(f.sent.filter((o) => o.t === "endpoint-close"), [{ t: "endpoint-close", endpoint, reason: "revoked" }], "the run's exit revokes it");
});

test("through the real supervisor: a failed spawn revokes the endpoint minted for it; a later message answers revoked", { skip }, async (t) => {
  let endpoint = "";
  const f = await setup(t, async (spec) => {
    endpoint = spec.messagesEndpoint?.endpoint ?? "";
    throw new Error("spawn failed");
  });
  await assert.rejects(f.start());
  assert.ok(endpoint.length > 0, "an endpoint was minted for the spawn");
  assert.deepEqual(f.sent, [{ t: "endpoint-close", endpoint, reason: "revoked" }], "revoked at once");
  assert.deepEqual(f.reply(await f.relay({ t: "relay-open", endpoint, conn: "c0" })), [{ t: "endpoint-close", endpoint, reason: "revoked" }, { ok: false, reason: "revoked" }], "a revoked endpoint is closed again (idempotent), then refused");
});

test("through the real supervisor: while QUEUED a relay-close answers nothing and changes nothing, and a frame answers not_ready without revoking", { skip }, async (t) => {
  const seen: { rounds?: unknown[]; closes?: number } = {};
  const f = await setup(t, async (spec, inner) => {
    const e = spec.messagesEndpoint;
    assert.ok(e !== undefined, "the spawn spec carries the endpoint");
    await f.relay({ t: "relay-open", endpoint: e.endpoint, conn: "c0" });
    const frame = f.reply(await f.relay({ t: "relay-frame", endpoint: e.endpoint, conn: "c0", frame: JSON.stringify({ op: "auth", token: e.token }) }));
    const closed = await f.relay({ t: "relay-close", endpoint: e.endpoint, conn: "c0" });
    seen.rounds = [frame, closed];
    seen.closes = f.sent.filter((o) => o.t === "endpoint-close").length;
    return inner.spawn(spec);
  });
  await f.start();
  assert.deepEqual(seen.rounds, [[{ ok: false, reason: "not_ready" }], []], "a frame is not_ready (not authenticated as the worker) and a close answers nothing");
  assert.equal(seen.closes, 0, "nothing was revoked during the launch window");
  assert.equal(f.sent.filter((o) => o.t === "endpoint-close").length, 0, "nor afterwards");
});

test("through the real supervisor: a QUEUED endpoint whose worker's messaging is switched off is revoked, not answered not_ready", { skip }, async (t) => {
  let endpoint = "";
  let answer: unknown[] = [];
  const f = await setup(t, async (spec, inner) => {
    endpoint = spec.messagesEndpoint?.endpoint ?? "";
    f.r.journal.messages.setAgentSettings("w1", { acceptsFrom: "group", cliMessaging: false, muted: false });
    answer = f.reply(await f.relay({ t: "relay-open", endpoint, conn: "c0" }));
    return inner.spawn(spec);
  });
  await f.start();
  assert.deepEqual(answer, [{ t: "endpoint-close", endpoint, reason: "revoked" }, { ok: false, reason: "revoked" }], "the setting is checked before the launch window");
});

test("through the real supervisor: a connection opened while QUEUED is not open afterwards: its frame is refused once the run is RUNNING, and a new open serves", { skip }, async (t) => {
  const seen: { endpoint?: string; token?: string } = {};
  const f = await setup(t, async (spec, inner) => {
    const e = spec.messagesEndpoint;
    assert.ok(e !== undefined, "the spawn spec carries the endpoint");
    seen.endpoint = e.endpoint;
    seen.token = e.token;
    f.reply(await f.relay({ t: "relay-open", endpoint: e.endpoint, conn: "c0" })); // answered not_ready: nothing was registered
    return inner.spawn(spec);
  });
  const { run } = (await f.start()) as { run: { runId: string } };
  assert.equal(f.r.journal.getRun(run.runId)?.state, "RUNNING");
  const endpoint = seen.endpoint as string;
  const auth = JSON.stringify({ op: "auth", token: seen.token });
  assert.deepEqual(f.reply(await f.relay({ t: "relay-frame", endpoint, conn: "c0", frame: auth })), [{ ok: false, reason: "refused" }], "the connection opened while QUEUED was never registered");
  assert.deepEqual(await f.relay({ t: "relay-open", endpoint, conn: "c1" }), []);
  assert.deepEqual(f.reply(await f.relay({ t: "relay-frame", endpoint, conn: "c1", frame: auth })), [{ ok: true, op: "auth" }], "a fresh open serves");
});

test("through the host's binding (hostMessagingDeps): the user's switch turned off after start: a serving endpoint is revoked at its next message, and a new run is minted none", { skip }, async (t) => {
  const specs: { messagesEndpoint?: { endpoint: string; token: string } }[] = [];
  const f = await setup(t, async (spec, inner) => (specs.push(spec), inner.spawn(spec)));
  await f.start();
  const e = specs[0]?.messagesEndpoint;
  assert.ok(e !== undefined, "minted while the switch was on");
  assert.deepEqual(await f.relay({ t: "relay-open", endpoint: e.endpoint, conn: "c1" }), []);
  assert.deepEqual(f.reply(await f.relay({ t: "relay-frame", endpoint: e.endpoint, conn: "c1", frame: JSON.stringify({ op: "auth", token: e.token }) })), [{ ok: true, op: "auth" }]);
  f.r.journal.cliEndpoint.switchOff(); // the user's disable, read by the host's binding per call (never once at wiring)
  assert.deepEqual(f.reply(await f.relay({ t: "relay-frame", endpoint: e.endpoint, conn: "c1", frame: JSON.stringify({ op: "read", id: "r1" }) })), [{ t: "endpoint-close", endpoint: e.endpoint, reason: "revoked" }, { ok: false, reason: "revoked" }], "revoked at its next message");
  // A new run of the same worker, launching (QUEUED, as the supervisor spawns it): the host's binding mints it nothing.
  const next = f.r.journal.createRun({ workspaceId: f.ws, kind: "cli", createdBy: "user", agentId: "w1" }).value.id;
  assert.equal(f.r.journal.getRun(next)?.state, "QUEUED");
  assert.equal(f.mint(next), undefined, "nothing is minted after the switch is off");
});

test("audit B F3 through the host's binding: a run that went BLOCKED and back to RUNNING with no message between answers revoked at its next message", { skip }, async (t) => {
  const specs: { runId: string; messagesEndpoint?: { endpoint: string; token: string } }[] = [];
  const f = await setup(t, async (spec, inner) => (specs.push(spec), inner.spawn(spec)));
  await f.start();
  const e = specs[0]?.messagesEndpoint;
  const runId = specs[0]?.runId as string;
  assert.ok(e !== undefined);
  assert.deepEqual(await f.relay({ t: "relay-open", endpoint: e.endpoint, conn: "c1" }), []);
  assert.deepEqual(f.reply(await f.relay({ t: "relay-frame", endpoint: e.endpoint, conn: "c1", frame: JSON.stringify({ op: "auth", token: e.token }) })), [{ ok: true, op: "auth" }]);
  f.r.journal.transitionRun(runId, "BLOCKED");
  f.r.journal.transitionRun(runId, "RUNNING");
  assert.deepEqual(f.reply(await f.relay({ t: "relay-frame", endpoint: e.endpoint, conn: "c1", frame: JSON.stringify({ op: "read", id: "r1" }) })), [{ t: "endpoint-close", endpoint: e.endpoint, reason: "revoked" }, { ok: false, reason: "revoked" }]);
});
