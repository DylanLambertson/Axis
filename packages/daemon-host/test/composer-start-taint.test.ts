// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createRunBudget, type GenerateResult } from "@axis/providers";
import { runComposerLoop, type ComposerApprovalNote, type ComposerRunTools } from "../src/index.js";
import { composerRig, START, until, type ComposerRig } from "./composer-rig.js";

// PV-T1 slice 2b, the pre-taint seam: a run started with IAC-T receipts (a Start of an untrusted task, source 5) is tainted
// before its tools exist, so the FIRST model reply is already decided under the flag; a receipt that cannot be recorded
// ends the run START_FAILED with nothing sent.

const RECEIPT = { source: "task_start", senderKind: "agent", sender: "w2", hop: 3, ref: "t1:2" };

async function setup(t: TestContext): Promise<ComposerRig> {
  const c = await composerRig({ replies: [] });
  t.after(() => c.cleanup());
  return c;
}
const newRun = (c: ComposerRig): string => c.journal.composer.createRun({ workspaceId: c.workspaceId, createdBy: "user" }, { mode: "agent", providerId: "mock", modelId: "mock-model" }).value.id;

test("receipts are taken while the tools are built: the run is tainted before build returns, and the first reply's write asks the user, listing the task", async (t) => {
  const c = await setup(t);
  const runId = newRun(c);
  const notes: ComposerApprovalNote[] = [];
  const tools: ComposerRunTools = (await c.agent.prepare(c.workspaceId))({ runId, workspaceId: c.workspaceId, windowId: "win-1", mode: "agent", receipts: [RECEIPT], onApproval: (n) => void notes.push(n) });
  assert.equal(c.journal.composer.tainted(runId), true, "tainted before any model call");
  let replies = 0;
  const end = runComposerLoop({
    runId, mode: "agent", prompt: "p", model: "mock-model", budget: createRunBudget({}), signal: new AbortController().signal, emit: () => undefined, tools,
    destination: { providerId: "mock", connectionId: "mock-connection", modelId: "mock-model", text: "Local" },
    provider: {
      generate: async (): Promise<GenerateResult> => {
        const first = replies++ === 0;
        return { model: "mock-model", usage: { inputTokens: 1, outputTokens: 1 }, stopReason: first ? "tool_use" : "end_turn", content: first ? [{ type: "tool_use" as const, id: "c1", name: "write_file", input: { path: "a.txt", content: "x" } as never }] : [] };
      },
    },
  });
  await until(() => notes.some((n) => n.state === "requested"), "the first reply's write was put to the user");
  const card = notes.find((n) => n.state === "requested");
  assert.ok(card?.reasons.includes("taint"));
  assert.deepEqual(card?.preview?.taint?.sources.map((s) => [s.source, s.sender, s.hop, s.ref]), [["task_start", "w2", 3, "t1:2"]]);
  assert.equal(existsSync(join(c.root, "a.txt")), false);
  const [ch] = (await c.user.call("axis.approvals", "pending", {})).result?.["challenges"] as { challengeId: string; digest: string }[];
  await c.user.call("axis.approvals", "resolve", { challengeId: ch?.challengeId, decision: "deny", digest: ch?.digest });
  await end;
  assert.deepEqual(c.audit.list({ limit: 100 }).filter((e) => e.action === "message.taint").map((e) => e.payload), [{ runId, source: "task_start", sourceId: "t1:2", senderKind: "agent", hop: 3 }]);
});

test("a run started through the service with a bad receipt ends START_FAILED with nothing sent; a good one is tainted from the start", async (t) => {
  const c = await setup(t);
  await assert.rejects(c.service.start(START(c.workspaceId, { taint: [{ ...RECEIPT, source: "not-a-source" }] }), new AbortController().signal));
  assert.equal(c.wire(), 0, "no provider request");
  const failed = c.journal.listRuns({ workspaceId: c.workspaceId }).filter((r) => r.state === "CANCELLED");
  assert.equal(failed.length, 1);
  assert.equal(failed[0]?.reason, "START_FAILED");
  assert.equal(c.journal.composer.tainted(failed[0]?.id as string), true, "the flag was set first, even for a bad receipt");
  const ask = await c.service.start(START(c.workspaceId, { mode: "ask", prompt: "q", taint: [RECEIPT] }), new AbortController().signal);
  assert.equal(c.journal.composer.tainted(ask.run.runId), true, "an ask run is tainted from the start too");
});
