// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Audit B F2 and F3: what an endpoint may still do after the state that allowed it changed.
// - F2: a send waiting on the secret scan when the switch goes off, the worker's messaging goes off, the run leaves RUNNING or the
//   sender is paused is re-checked inside the write: it answers `revoked` (or `paused`) and no message and no `message.send` row
//   is written.
// - F3: a run that left RUNNING (BLOCKED or REVIEWING) and came back has its endpoint revoked at the next message, and a run with
//   that history is minted nothing: "stays revoked" holds without a message in between.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { RelayOut } from "../src/index.js";
import { deliveryRig } from "./messages-delivery-rig.js";

function json(out: RelayOut | undefined): Record<string, unknown> {
  assert.ok(out !== undefined && out.t === "relay-reply", JSON.stringify(out));
  return JSON.parse(out.frame) as Record<string, unknown>;
}
/** A rig whose scan waits until the test releases it, an authenticated connection of worker c1, and its relay. */
async function held(t: TestContext) {
  let release: () => void = () => undefined;
  let entered = 0;
  const r = await deliveryRig(t, {
    noDelivery: true,
    // Only the first scan waits (the send under test); any other scan of the path answers at once.
    scan: async () => {
      if (++entered === 1) await new Promise<void>((res) => (release = res));
      return [];
    },
  });
  r.c.journal.messages.setAgentSettings("c1", { acceptsFrom: "group", cliMessaging: true, muted: false });
  const runId = r.run("c1");
  const minted = r.m.endpoints.relay.mint(runId);
  assert.ok(minted !== undefined);
  const relay = (m: Parameters<typeof r.m.endpoints.relay.onRelay>[1]) => r.m.endpoints.relay.onRelay(r.m.endpoints.source, m);
  const frame = (body: unknown) => relay({ t: "relay-frame", endpoint: minted.endpointId, conn: "c-1", frame: JSON.stringify(body) });
  await relay({ t: "relay-open", endpoint: minted.endpointId, conn: "c-1" });
  assert.deepEqual(json((await frame({ op: "auth", token: minted.token }))[0]), { ok: true, op: "auth" });
  const sends = () => r.c.audit.list({ limit: 5000 }).filter((e) => e.action === "message.send").length;
  // Wrapped: an async function returning the pending promise itself would wait for it (promises flatten).
  const sendInScan = async (): Promise<{ readonly pending: Promise<readonly RelayOut[]> }> => {
    const pending = frame({ op: "send", id: "s1", recipients: [{ agent: "a1" }], body: "late" });
    // Microtasks only: this rig's clock is fake, so a timer-based wait would never fire.
    for (let i = 0; i < 10_000 && entered === 0; i++) await Promise.resolve();
    assert.ok(entered >= 1, "the send is waiting on the scan");
    return { pending };
  };
  return { r, runId, ep: minted.endpointId, frame, sends, sendInScan, release: () => release() };
}

for (const [label, change, reason] of [
  ["the switch turned off and every endpoint revoked", (h: Awaited<ReturnType<typeof held>>) => { h.r.c.journal.cliEndpoint.switchOff(); h.r.m.endpoints.relay.revokeAll(); }, "revoked"],
  ["the switch turned off (no eager revoke reached it)", (h: Awaited<ReturnType<typeof held>>) => void h.r.c.journal.cliEndpoint.switchOff(), "revoked"],
  ["the worker's messaging turned off", (h: Awaited<ReturnType<typeof held>>) => h.r.c.journal.messages.setAgentSettings("c1", { acceptsFrom: "group", cliMessaging: false, muted: false }), "revoked"],
  ["the run left RUNNING", (h: Awaited<ReturnType<typeof held>>) => void h.r.c.journal.transitionRun(h.runId, "BLOCKED"), "revoked"],
] as const) {
  test(`F2: a send waiting on the scan when ${label} is refused ${reason}, and nothing is written`, async (t) => {
    const h = await held(t);
    const before = h.sends();
    const { pending } = await h.sendInScan();
    change(h);
    h.release();
    const out = await pending;
    // Refused as the relay refuses a revoked or paused endpoint: on the connection, which it closes.
    assert.deepEqual(json(out.find((o) => o.t === "relay-reply")), { ok: false, reason }, JSON.stringify(out));
    assert.equal(h.sends(), before, "no message.send row");
    assert.deepEqual(h.r.m.service.read({ kind: "agent", agentId: "a1", runId: null, verified: true, receivedHop: 0 }, {}).messages, [], "no message");
  });
}

test("F2: a send waiting on the scan when the sender's group is paused is refused paused, and nothing is written", async (t) => {
  const h = await held(t);
  const before = h.sends();
  const { pending } = await h.sendInScan();
  await h.r.m.settings.pause({ kind: "user" }, { scope: { group: "g1" } } as never);
  h.release();
  const out = await pending;
  const replyOrRefuse = out.find((o) => o.t === "relay-reply");
  assert.equal(json(replyOrRefuse)["reason"], "paused", JSON.stringify(out));
  assert.equal(h.sends(), before);
});

test("F3: RUNNING, BLOCKED, RUNNING with no message between: the next message revokes the endpoint", async (t) => {
  const h = await held(t);
  h.release(); // no scan in this test
  h.r.c.journal.transitionRun(h.runId, "BLOCKED");
  h.r.c.journal.transitionRun(h.runId, "RUNNING");
  assert.equal(h.r.c.journal.getRun(h.runId)?.state, "RUNNING", "the run is RUNNING again");
  const out = await h.frame({ op: "read", id: "r1" });
  assert.deepEqual(out[0], { t: "endpoint-close", endpoint: h.ep, reason: "revoked" }, "stays revoked");
  assert.deepEqual(json(out[1]), { ok: false, reason: "revoked" });
});

test("F3: a run that has left RUNNING once is minted nothing, even RUNNING again", async (t) => {
  const r = await deliveryRig(t, { noDelivery: true });
  r.c.journal.messages.setAgentSettings("c1", { acceptsFrom: "group", cliMessaging: true, muted: false });
  const runId = r.run("c1");
  r.c.journal.transitionRun(runId, "BLOCKED");
  r.c.journal.transitionRun(runId, "RUNNING");
  assert.equal(r.m.endpoints.relay.mint(runId), undefined);
  assert.ok(r.m.endpoints.relay.mint(r.run("c1")) !== undefined, "a fresh run of the worker is minted as before");
});
