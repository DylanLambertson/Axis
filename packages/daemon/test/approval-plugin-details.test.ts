// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// PV-K1e-a2: a plugin that caused a challenge learns its id only; every other requester gets the challenge as before.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { challengeSchema, errorSchema, type Challenge } from "@axis/protocol";
import type { IdentityVerifier } from "../src/index.js";
import { fakeGate } from "./gate.js";
import { CONTRACT, KEY1, identityOf, req, rig, type Rig } from "./harness.js";

const plugin: IdentityVerifier = {
  verify: (att) =>
    att === "good"
      ? identityOf({ actor: "plugin:acme.board", actorId: "plugin:acme.board", clientKind: "plugin", windowId: "p1", hostWindowId: "w1", workspaceId: "proj", trusted: false })
      : undefined,
};

async function ready(t: TestContext, options: Parameters<typeof rig>[0] = {}): Promise<Rig> {
  const r = rig(options);
  t.after(() => r.cleanup());
  await r.handshake();
  return r;
}

test("a plugin's E_APPROVAL_REQUIRED carries the challenge id only, never the summary, digest, method or tier", async (t) => {
  const { gate, calls } = fakeGate();
  const r = await ready(t, { gate, identity: plugin });
  r.daemon.register(CONTRACT, 1, { danger: () => assert.fail("must not run") });
  r.send(req("a1", "danger", { id: "ws-1" }, { idempotencyKey: KEY1 }));
  const res = await r.inbox.response("a1");
  assert.equal(res.error?.code, "E_APPROVAL_REQUIRED");
  assert.doesNotThrow(() => errorSchema.parse(res.error));
  const issued = calls.issue.length;
  assert.equal(issued, 1, "the gate issued it");
  const shown = (res.error?.details as { challenge: Record<string, unknown> }).challenge;
  assert.deepEqual(Object.keys(shown), ["challengeId"]);
  assert.match(String(shown["challengeId"]), /^[A-Za-z0-9_-]{16,}$/);
});

test("an ordinary requester's details are unchanged: the whole schema-valid challenge", async (t) => {
  const { gate } = fakeGate();
  const r = await ready(t, { gate });
  r.daemon.register(CONTRACT, 1, { danger: () => assert.fail("must not run") });
  r.send(req("a1", "danger", { id: "ws-1" }, { idempotencyKey: KEY1 }));
  const res = await r.inbox.response("a1");
  const shown = (res.error?.details as { challenge: Challenge }).challenge;
  assert.doesNotThrow(() => challengeSchema.parse(shown));
  assert.deepEqual(Object.keys(shown).sort(), ["challengeId", "contract", "digest", "expiresAt", "method", "nativeConfirmationRequired", "targetSummary", "tier"]);
});
