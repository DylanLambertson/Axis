// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createDaemonHost } from "../src/index.js";
import { hostFixture } from "../testing/host-fixture.js";
import { must } from "./helpers.js";

test("the host's real audit log keeps `method` on challenge rows and the anchor literals on anchor rows", async () => {
  const fix = hostFixture();
  const host = createDaemonHost(fix.config, fix.ports);
  try {
    const s = await host.start();
    const audit = must(s.audit);
    audit.append({ actor: "user", action: "tier4.challenge", target: "sha256:x", outcome: "success", payload: { phase: "issued", method: "remove", ref: "r", tier: 4 } });
    audit.append({ actor: "user", action: "tier4.execute", target: "sha256:x", outcome: "success", payload: { phase: "executed", method: "remove", ref: "r", tier: 4 } });
    // DMN-5 (agents): a broker decision keeps who approved it, the approval id and its expiry.
    audit.append({ actor: "agent:composer.r1", action: "broker.decision", target: "worktree:w1", outcome: "success", payload: { tool: "write_file", decision: "approved", approvedBy: "user", approvalId: "chl:0123456789abcdef", expiresAt: 1_800_000_000_000, extra: "dropped" } });
    audit.append({ actor: "daemon", action: "anchor.stalled", target: "daemon:anchor", outcome: "success", payload: { reason: "anchor_stalled", extra: "dropped" } });
    audit.append({ actor: "daemon", action: "anchor.resumed", target: "daemon:anchor", outcome: "success", payload: { code: "resumed", extra: "dropped" } });
    const rows = s.auditRead.list({ limit: 50 });
    const payload = (action: string): Record<string, unknown> => rows.find((e) => e.action === action)?.payload as Record<string, unknown>;
    assert.equal(payload("tier4.challenge")["method"], "remove");
    assert.equal(payload("tier4.execute")["method"], "remove");
    assert.equal(payload("anchor.stalled")["reason"], "anchor_stalled");
    assert.equal(payload("anchor.resumed")["code"], "resumed");
    assert.equal(payload("anchor.stalled")["extra"], undefined, "a key outside the allow-list is not stored");
    const decision = payload("broker.decision");
    assert.deepEqual([decision["approvedBy"], decision["approvalId"], decision["expiresAt"], decision["extra"]], ["user", "chl:0123456789abcdef", 1_800_000_000_000, undefined]);
  } finally {
    await host.stop();
    fix.cleanup();
  }
});
