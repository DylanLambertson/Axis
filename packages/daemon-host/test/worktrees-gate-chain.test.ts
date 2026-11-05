// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { requestDigest } from "@axis/daemon";
import { ChannelMux, ControlClient, createChallengeAuditSink, createWorktreesApprovals } from "../src/index.js";
import { memoryChannelPair } from "../testing/memory-channel.js";
import { fakeClock } from "./helpers.js";

// A separate file: the export walker calls every export with hostile arguments and must not share a process's state with this.
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
