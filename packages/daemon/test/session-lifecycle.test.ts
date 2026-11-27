// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// `DaemonOptions.lifecycle` (PV-K2 K2-g4a, plugin-grant-contract.md section 8.4): `accepted` and `closed` once per attested
// session, with that session's frozen identity; nothing for a refused attestation or a refused duplicate connection id; a throwing
// hook is reported and changes nothing else.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { Identity } from "../src/index.js";
import { isAttestedIdentity } from "../src/index.js";
import { cid, hello, req, rig, untilTrue, verifier, type Rig } from "./harness.js";

interface Seen {
  accepted: Identity[];
  closed: Identity[];
}

function mk(t: TestContext, att: unknown = "good", hook?: Partial<{ accepted: (i: Identity) => void; closed: (i: Identity) => void }>, slow = false): Rig & { seen: Seen } {
  const seen: Seen = { accepted: [], closed: [] };
  const r = rig({
    attestation: att,
    // A verifier that answers on a later turn, so messages sent meanwhile are queued and replayed after `accepted`.
    ...(slow ? { identity: { verify: (a: unknown) => new Promise((resolve) => setTimeout(() => resolve(verifier.verify(a)), 20)) } } : {}),
    lifecycle: {
      accepted: (i) => {
        seen.accepted.push(i);
        hook?.accepted?.(i);
      },
      closed: (i) => {
        seen.closed.push(i);
        hook?.closed?.(i);
      },
    },
  });
  t.after(() => r.cleanup());
  return Object.assign(r, { seen });
}

test("accepted once with the session's attested identity, closed once when the port closes", async (t) => {
  const r = mk(t, "good~w7");
  await untilTrue(() => r.seen.accepted.length === 1, undefined, "accepted");
  const [identity] = r.seen.accepted;
  assert.equal(identity?.windowId, "w7");
  assert.equal(identity?.connectionId, cid("conn-1"));
  assert.ok(isAttestedIdentity(identity), "the very identity the session holds");
  assert.deepEqual(r.seen.closed, []);
  r.client.close();
  await untilTrue(() => r.seen.closed.length === 1, undefined, "closed");
  assert.equal(r.seen.closed[0], identity);
  r.daemon.stop();
  assert.equal(r.seen.closed.length, 1, "a session closes once");
  assert.equal(r.seen.accepted.length, 1);
});

test("accepted comes before anything the queued handshake messages do, even a close they cause", async (t) => {
  const order: string[] = [];
  const r = mk(t, "good", { accepted: () => void order.push("accepted"), closed: () => void order.push("closed") }, true);
  r.send(req("1", "echo", { text: "x" })); // queued before the attestation is verified; a request before hello closes the session at once
  assert.ok(await r.inbox.closedWithin());
  await untilTrue(() => order.length === 2, undefined, "both");
  assert.deepEqual(order, ["accepted", "closed"]);
});

test("a refused attestation calls neither", async (t) => {
  const r = mk(t, "bad");
  assert.ok(await r.inbox.closedWithin());
  assert.deepEqual(r.seen, { accepted: [], closed: [] });
});

test("a refused duplicate connection id calls neither; the first session's close is the only close", async (t) => {
  const r = mk(t, "good");
  await untilTrue(() => r.seen.accepted.length === 1, undefined, "first accepted");
  const second = r.connect("good");
  assert.ok(await second.inbox.closedWithin());
  assert.equal(r.seen.accepted.length, 1);
  assert.deepEqual(r.seen.closed, []);
  r.client.close();
  await untilTrue(() => r.seen.closed.length === 1, undefined, "first closed");
});

test("stop closes every session through the hook, once each", async (t) => {
  const r = mk(t, "good#a~w1");
  r.connect("good#b~w1");
  r.connect("good#c~w2");
  await untilTrue(() => r.seen.accepted.length === 3, undefined, "three accepted");
  r.daemon.stop();
  r.daemon.stop();
  assert.deepEqual(r.seen.closed.map((i) => i.connectionId).sort(), [cid("a"), cid("b"), cid("c")]);
});

test("a throwing hook is reported and the session still serves and still closes once", async (t) => {
  const r = mk(t, "good", {
    accepted: () => {
      throw new Error("accepted boom");
    },
    closed: () => {
      throw new Error("closed boom");
    },
  });
  r.send(hello());
  await r.inbox.until((m): m is { type: string } => (m as { type?: unknown }).type === "welcome");
  r.client.close();
  await untilTrue(() => r.seen.closed.length === 1, undefined, "closed");
  r.daemon.stop();
  assert.equal(r.seen.closed.length, 1);
  assert.deepEqual(r.internal.map((x) => x.correlationId).sort(), ["lifecycle", "lifecycle"]);
});
