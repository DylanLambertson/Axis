// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { requestDigest } from "@axis/daemon";
import { ChannelMux, ControlClient, createChallengeAuditSink, createWorktreesApprovals } from "../src/index.js";
import { memoryChannelPair } from "../testing/memory-channel.js";
import { fakeClock } from "./helpers.js";

// This file stays separate from the export walker, which calls every export with hostile arguments; the walker now skips zod
// schemas (whose internals rewrite zod's shared prototypes when called that way), but isolation costs nothing.
test("a tier 3 challenge (no native dialog) issued, approved with the port and executed through the gate yields NO capability", async () => {
  const { a } = memoryChannelPair();
  const mux = new ChannelMux(a);
  const control = new ControlClient({ mux });
  const approvals = createWorktreesApprovals({ audit: createChallengeAuditSink({ append: () => undefined }), control, clock: fakeClock() });
  try {
    for (const method of ["remove", "finalise"]) {
      const args = { id: "ws-1" };
      // Fresh objects: the walker above passed the shared ones to hostile calls.
      const call = {
        contract: "axis.worktrees", contractVersion: 1, method, tier: 3, args, digest: requestDigest("axis.worktrees", 1, method, args),
        actor: "user", connectionId: "c".padEnd(22, "_"), requestId: "r", correlationId: "c", signal: new AbortController().signal,
        identity: { connectionId: "c".padEnd(22, "_"), windowId: "w", actorId: "a", actor: "user", trusted: true, clientKind: "desktop" },
      };
      const content = { target: "workspace:ws-1", contentDigest: "a".repeat(64) };
      const challenge = await approvals.gate.issue(call as never, content);
      assert.equal(challenge.nativeConfirmationRequired, false);
      approvals.port.resolve({ actor: "user", windowId: "w" }, { challengeId: challenge.challengeId, decision: "approve", digest: challenge.digest } as never);
      let seen: unknown = "not run";
      await approvals.gate.execute(call as never, { challengeId: challenge.challengeId } as never, content, async (confirmed) => {
        seen = (confirmed as { capability?: unknown }).capability;
        return undefined;
      });
      assert.equal(seen, undefined, method);
    }
  } finally {
    approvals.dispose();
    control.dispose();
    mux.dispose();
  }
});

const fresh = (method: string, tier: number) => {
  const args = { id: "ws-1" };
  return {
    contract: "axis.worktrees", contractVersion: 1, method, tier, args, digest: requestDigest("axis.worktrees", 1, method, args),
    actor: "user", connectionId: "c".padEnd(22, "_"), requestId: "r", correlationId: "c", signal: new AbortController().signal,
    identity: { connectionId: "c".padEnd(22, "_"), windowId: "w", actorId: "a", actor: "user", trusted: true, clientKind: "desktop" },
  };
};

test("issued at tier 3 and executed claiming tier 4: refused before the spend, no capability; the real tier 3 execute still works", async () => {
  const { a } = memoryChannelPair();
  const mux = new ChannelMux(a);
  const control = new ControlClient({ mux });
  const approvals = createWorktreesApprovals({ audit: createChallengeAuditSink({ append: () => undefined }), control, clock: fakeClock() });
  try {
    const content = { target: "workspace:ws-1", contentDigest: "a".repeat(64) };
    const challenge = await approvals.gate.issue(fresh("remove", 3) as never, content);
    approvals.port.resolve({ actor: "user", windowId: "w" }, { challengeId: challenge.challengeId, decision: "approve", digest: challenge.digest } as never);
    let ran = false;
    await assert.rejects(
      approvals.gate.execute(fresh("remove", 4) as never, { challengeId: challenge.challengeId } as never, content, async (c) => {
        ran = true;
        return (c as { capability?: unknown }).capability;
      }),
      (e: unknown) => (e as { code?: string }).code === "E_CONFLICT",
    );
    assert.equal(ran, false, "the action did not run");
    // The refusal spent nothing: executing at the tier it was issued at works, with no capability.
    let seen: unknown = "not run";
    await approvals.gate.execute(fresh("remove", 3) as never, { challengeId: challenge.challengeId } as never, content, async (c) => {
      seen = (c as { capability?: unknown }).capability;
    });
    assert.equal(seen, undefined);
    // A tier that is not an integer is refused at issue and at execute.
    for (const tier of [undefined, 3.5, Number.NaN, "4"]) {
      await assert.rejects(async () => approvals.gate.issue({ ...fresh("remove", 4), tier } as never, content), (e: unknown) => (e as { code?: string }).code === "E_INVALID_ARGUMENT");
    }
  } finally {
    approvals.dispose();
    control.dispose();
    mux.dispose();
  }
});

test("issued at tier 4 (native) and executed claiming tier 3: refused", async () => {
  const { a, b } = memoryChannelPair();
  const mux = new ChannelMux(a);
  const control = new ControlClient({ mux });
  b.onMessage(() => undefined);
  const approvals = createWorktreesApprovals({ audit: createChallengeAuditSink({ append: () => undefined }), control, clock: fakeClock() });
  try {
    const content = { target: "workspace:ws-1", contentDigest: "a".repeat(64) };
    const challenge = await approvals.gate.issue(fresh("remove", 4) as never, content);
    await assert.rejects(
      approvals.gate.execute(fresh("remove", 3) as never, { challengeId: challenge.challengeId } as never, content, async () => undefined),
      (e: unknown) => (e as { code?: string }).code === "E_CONFLICT",
    );
  } finally {
    approvals.dispose();
    control.dispose();
    mux.dispose();
    b.close();
  }
});

test("a tier 3 challenge whose issue record was evicted, executed claiming tier 4, still gets no capability", async () => {
  const { a } = memoryChannelPair();
  const mux = new ChannelMux(a);
  const control = new ControlClient({ mux });
  const approvals = createWorktreesApprovals({
    audit: createChallengeAuditSink({ append: () => undefined }),
    control,
    clock: fakeClock(),
    limits: { maxOutstandingTotal: 4, maxOutstandingPerActor: 4, maxOutstandingPerActorOverall: 4, maxOutstandingPerWindow: 4 },
  });
  try {
    const content = { target: "workspace:ws-1", contentDigest: "a".repeat(64) };
    const victim = await approvals.gate.issue(fresh("remove", 3) as never, content);
    approvals.port.resolve({ actor: "user", windowId: "w" }, { challengeId: victim.challengeId, decision: "approve", digest: victim.digest } as never);
    // More issues than the tier table holds (its cap is twice the quota): the victim's record is pushed out. Each other
    // challenge is DENIED at once, which leaves the quota (a withdrawn one would keep counting), so the quota never refuses.
    for (let i = 0; i < 12; i++) {
      const other = await approvals.gate.issue(fresh("remove", 3) as never, { target: `workspace:ws-${i + 2}`, contentDigest: "a".repeat(64) });
      approvals.port.resolve({ actor: "user", windowId: "w" }, { challengeId: other.challengeId, decision: "deny", digest: other.digest } as never);
    }
    let seen: unknown = "not run";
    await approvals.gate.execute(fresh("remove", 4) as never, { challengeId: victim.challengeId } as never, content, async (c) => {
      seen = (c as { capability?: unknown }).capability;
    });
    assert.equal(seen, undefined, "no capability without a record of the tier it was issued at");
  } finally {
    approvals.dispose();
    control.dispose();
    mux.dispose();
  }
});
