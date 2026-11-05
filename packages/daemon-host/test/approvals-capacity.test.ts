// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { issue4, resolve, setup, waitFor, WT } from "./approvals-helpers.js";
import { newKey, removePayload } from "./approvals-rig.js";

test("a full native queue refuses before any challenge exists, so the refused window is not locked out after it drains (SF-A)", async (t) => {
  const { r } = await setup(t, { nativeWaitLimit: 4, nativeWaitPerWindow: 2 });
  const a = await r.connect("user#conn-a#win-a");
  const b = await r.connect("user#conn-b#win-b");
  const victim = await r.connect("user#conn-v#win-v");
  const held = [];
  for (const c of [a, a, b, b]) held.push(await issue4(r, c, { id: `ws-${held.length}` }));
  const issuedBefore = r.challengeEvents.length;
  for (let n = 0; n < 10; n++) {
    assert.equal((await victim.call(WT, "remove", removePayload({ id: "ws-v" }), newKey())).error?.code, "E_BACKPRESSURE");
  }
  assert.equal(r.challengeEvents.length, issuedBefore, "a refusal writes no audit row and makes no challenge");
  // Drain the queue: each user denies its own challenges.
  for (const [i, h] of held.entries()) await resolve(i < 2 ? a : b, h.challenge, "deny");
  await waitFor(() => r.approvals.stats().native.entries === 0);
  const ok = await victim.call(WT, "remove", removePayload({ id: "ws-v" }), newKey());
  assert.equal(ok.error?.code, "E_APPROVAL_REQUIRED", "no tombstone from the refused attempts");
});

test("one window cannot take every native slot: its share is half by default and configurable", async (t) => {
  const { r } = await setup(t, { nativeWaitLimit: 4 });
  const a = await r.connect("user#conn-a#win-a");
  const b = await r.connect("user#conn-b#win-b");
  await issue4(r, a, { id: "ws-1" });
  await issue4(r, a, { id: "ws-2" });
  assert.equal((await a.call(WT, "remove", removePayload({ id: "ws-3" }), newKey())).error?.code, "E_BACKPRESSURE");
  assert.equal((await b.call(WT, "remove", removePayload({ id: "ws-4" }), newKey())).error?.code, "E_APPROVAL_REQUIRED");
});

test("the connection closing while issue waits for the native request leaves no listing and no audit noise", async (t) => {
  const { r, user } = await setup(t);
  const first = await user.call(WT, "remove", removePayload(), newKey());
  assert.equal(first.error?.code, "E_APPROVAL_REQUIRED"); // control: normal issue still works
  // Direct gate use, as the pipeline does it, with the connection closing inside the one-turn wait.
  const { approvals } = r;
  const input = {
    identity: { connectionId: "conn-x", windowId: "win-1", actorId: "u", actor: "user", trusted: true, clientKind: "desktop" },
    actor: "user", connectionId: "conn-x", requestId: "q", correlationId: "x", contract: "axis.worktrees", contractVersion: 1,
    method: "remove", tier: 4, args: { id: "ws-9" }, digest: (await import("@axis/daemon")).requestDigest("axis.worktrees", 1, "remove", { id: "ws-9" }),
    signal: new AbortController().signal,
  } as unknown as Parameters<typeof approvals.gate.issue>[0];
  const rows = r.challengeEvents.length;
  const pending = approvals.gate.issue(input, { target: "workspace:ws-9", contentDigest: "e".repeat(64) });
  approvals.gate.withdrawConnection?.("conn-x");
  const challenge = (await pending) as { challengeId: string };
  approvals.gate.withdraw?.(challenge.challengeId, { actor: "user", connectionId: "conn-x" });
  assert.equal(approvals.stats().withdrawErrors, 0);
  assert.equal(approvals.stats().native.entries, 1, "only the first, normal challenge is waiting");
  assert.equal(r.challengeEvents.slice(rows).map((e) => String(e.payload["phase"])).join(), "issued,withdraw", "one issue row, one withdraw row by the connection close, none for wrong_caller");
  assert.equal(approvals.port.pending("win-1").filter((c) => c.challengeId === challenge.challengeId).length, 0);
});

test("a challenge the manager refuses (quota) gives its native place back", async (t) => {
  const { r } = await setup(t, { nativeWaitLimit: 2, nativeWaitPerWindow: 2, limits: { maxOutstandingPerWindow: 1 } });
  const a = await r.connect("user#conn-a#win-a");
  const b = await r.connect("user#conn-b#win-b");
  await issue4(r, a, { id: "ws-1" });
  for (let n = 0; n < 3; n++) assert.equal((await a.call(WT, "remove", removePayload({ id: "ws-2" }), newKey())).error?.code, "E_BACKPRESSURE");
  assert.equal((await b.call(WT, "remove", removePayload({ id: "ws-3" }), newKey())).error?.code, "E_APPROVAL_REQUIRED");
});
