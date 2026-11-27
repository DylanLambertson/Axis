// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRunBudget } from "@axis/providers";
import { ComposerRunHalt, runComposerLoop, type ComposerRunTools, type LoopEnd, type MessageCaller } from "../src/index.js";
import { deliveryRig } from "./messages-delivery-rig.js";

// PV-M3 slice 2, review 2 (NIT 6): the order of the turn boundary (the WT-2 guard before a delivery, no delivery once
// the run is cancelled) and the quarantine notice that adds the user to a thread it was not in.

/** Run the loop over fake tools: one reply with one tool call, then a reply with none. Returns the end and the tools' log. */
async function boundary(over: (log: string[]) => Partial<ComposerRunTools>, signal = new AbortController().signal): Promise<{ end: LoopEnd; log: string[] }> {
  const log: string[] = [];
  const tools: ComposerRunTools = {
    specs: [],
    invoke: async () => (log.push("invoke"), { ok: true, content: "done" }),
    deliver: async () => (log.push("deliver"), { text: "[axis-delivery x] block", ack: () => void log.push("ack"), release: () => void log.push("release") }),
    ...over(log),
  };
  let n = 0;
  const end = await runComposerLoop({
    runId: "r1", mode: "agent", prompt: "p", model: "m", budget: createRunBudget({}), signal, emit: () => undefined, tools,
    destination: { providerId: "mock", connectionId: "mock-connection", modelId: "m", text: "Local" },
    provider: {
      generate: async () => {
        log.push("generate");
        const first = n++ === 0;
        return { model: "m", usage: { inputTokens: 1, outputTokens: 1 }, stopReason: first ? "tool_use" : "end_turn", content: first ? [{ type: "tool_use" as const, id: "c1", name: "read_file", input: {} as never }] : [] };
      },
    },
  });
  return { end, log };
}

test("WT-2 before delivery: a run halted at the boundary is delivered nothing, so it is never tainted by a block it cannot use", async () => {
  const { end, log } = await boundary((log) => ({
    guard: async () => {
      log.push("guard");
      throw new ComposerRunHalt("GIT_DRIFT");
    },
  }));
  assert.deepEqual(end, { state: "FAILED", reason: "GIT_DRIFT" });
  assert.deepEqual(log, ["generate", "invoke", "guard"], "the guard ran at the boundary and ended the run before any delivery");
});

test("a run cancelled at the boundary (after the guard) asks for no delivery", async () => {
  const controller = new AbortController();
  const { end, log } = await boundary(() => ({ guard: async () => void controller.abort() }), controller.signal);
  assert.deepEqual(end, { state: "CANCELLED", reason: "USER_CANCELLED" });
  assert.deepEqual(log, ["generate", "invoke"], "no delivery, so nothing was leased or tainted");
});

const USER: MessageCaller = { kind: "user" };

test("the quarantine notice adds the user to a thread it was not in, and does not add it twice", async (t) => {
  const r = await deliveryRig(t);
  const a2: MessageCaller = { kind: "agent", agentId: "a2", runId: null, verified: true, receivedHop: 0 };
  const sendAs = async (from: MessageCaller, threadId?: string) =>
    (await r.m.service.send(from, { recipients: [{ agent: "a1" }], body: { format: "text", text: "poison" }, ...(threadId === undefined ? {} : { threadId }) })).message;
  const fromAgent = await sendAs(a2);
  assert.equal(r.c.journal.messages.participant(fromAgent.threadId, "user"), undefined, "an agents' thread without the user");
  for (let i = 0; i < 3; i++) assert.throws(() => r.m.delivery.next(r.run("a1"), { receive: () => { throw new Error("audit down"); } }));
  assert.equal(r.c.journal.messages.deliveries.get(fromAgent.messageId, "agent:a1")?.state, "failed");
  const joined = r.c.journal.messages.participant(fromAgent.threadId, "user");
  assert.ok(joined !== undefined, "the user joined with the notice");
  const notice = r.m.service.thread(USER, { threadId: fromAgent.threadId }).messages.at(-1);
  assert.equal(notice?.sender.kind, "system");
  assert.equal(joined.joinedSeq, (notice?.seq ?? 0) - 1, "the user joined with the notice, so it reads it");
  // A thread the user is already in: the notice is posted without a second join (which the table would refuse).
  const opened = (await r.m.service.send(USER, { recipients: [{ agent: "a1" }, { agent: "a2" }], body: { format: "text", text: "plan" } })).message;
  const before = r.c.journal.messages.participants(opened.threadId).map((p) => p.principal);
  const poison = await sendAs(a2, opened.threadId);
  for (let i = 0; i < 3; i++) assert.throws(() => r.m.delivery.next(r.run("a1"), { receive: () => { throw new Error("audit down"); } }));
  assert.equal(r.c.journal.messages.deliveries.get(poison.messageId, "agent:a1")?.state, "failed");
  assert.deepEqual(r.c.journal.messages.participants(opened.threadId).map((p) => p.principal), before, "nobody joined twice");
  assert.equal(r.m.service.thread(USER, { threadId: opened.threadId }).messages.at(-1)?.sender.kind, "system", "the notice is posted");
});
