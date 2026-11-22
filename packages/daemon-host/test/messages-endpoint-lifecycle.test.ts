// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { HandlerContext } from "@axis/daemon";
import { attestedWindow } from "../testing/attested.js";
import { cliEndpointPty, createMessagingBinding, hostMessagingDeps, startCliRun, wireCliEndpoints, type CliEndpoints, type PtyPort, type RelayOut } from "../src/index.js";
import { newKey } from "./approvals-rig.js";
import { runsRig, until } from "./runs-rig.js";
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
  const m = createMessagingBinding(hostMessagingDeps({ journal: r.journal, audit: r.audit, monotonic: () => r.clock.monotonic(), scan: async () => [], logger: undefined, holdsSecret: () => false, enabled: true }));
  const sent: RelayOut[] = [];
  const cleanups: (() => void)[] = [];
  t.after(() => cleanups.forEach((c) => c()));
  holder.cli = wireCliEndpoints({ enabled: true, cliEndpoint: true }, { onRelay: () => ({ dispose: () => undefined }), relay: (o: RelayOut) => (sent.push(o), true) }, m.endpoints, cleanups);
  const relay = (msg: Parameters<typeof m.endpoints.relay.onRelay>[1]) => m.endpoints.relay.onRelay(m.endpoints.source, msg);
  const reply = (outs: readonly RelayOut[]) => outs.map((o) => (o.t === "relay-reply" ? JSON.parse(o.frame) : o));
  const start = () => startCliRun(r.handlerDeps, { workspaceId: ws, entryId: "fake", worker: "w1" }, ctx);
  return { r, ws, sent, relay, reply, start };
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
  assert.deepEqual(f.reply(await f.relay({ t: "relay-open", endpoint, conn: "c0" })), [{ ok: false, reason: "revoked" }]);
});
