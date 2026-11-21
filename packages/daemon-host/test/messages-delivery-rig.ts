// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { randomBytes } from "node:crypto";
import type { TestContext } from "node:test";
import { createRunBudget, type GenerateResult } from "@axis/providers";
import { createMessagingBinding, runComposerLoop, type AgentEntry, type ComposerApprovalNote, type GroupEntry, type LoopEnd, type MessagingBinding, type MessagingDirectory } from "../src/index.js";
import { composerRig, type ComposerRig } from "./composer-rig.js";

/**
 * A composer rig (real journal, agent binding, broker, approvals and loop) with the message service and the delivery
 * pipeline on the same journal and audit log. Project p: group g1 holds composer agents a1 and a2 and CLI agent c1,
 * group g2 holds b1. `agentOf` maps a run to its agent (PV-G4 records it; the test sets it).
 */
export interface DeliveryRig {
  readonly c: ComposerRig;
  readonly m: MessagingBinding;
  readonly agents: Map<string, AgentEntry>;
  readonly runAgent: Map<string, string>;
  /** A RUNNING composer run of an agent. */
  run(agentId: string): string;
}

export async function deliveryRig(t: TestContext, options: { maxText?: number; failTaintAudit?: () => boolean } = {}): Promise<DeliveryRig> {
  const holder: { m?: MessagingBinding } = {};
  const c = await composerRig({
    replies: [],
    deliveries: { next: (runId, taint) => holder.m?.delivery.next(runId, taint) },
    ...(options.failTaintAudit === undefined ? {} : { failAudit: (action: string) => action === "message.taint" && options.failTaintAudit?.() === true }),
  });
  t.after(() => c.cleanup());
  c.journal.registerProject({ id: "p", path: "/repo/p", displayName: "p", trusted: true, actor: "user" });
  const agents = new Map<string, AgentEntry>();
  const groups = new Map<string, GroupEntry>();
  for (const [id, g, kind] of [["a1", "g1", "composer"], ["a2", "g1", "composer"], ["c1", "g1", "cli"], ["b1", "g2", "composer"]] as const) {
    agents.set(id, { agentId: id, projectId: "p", groupId: g, kind });
    groups.set(g, { groupId: g, projectId: "p", members: [...(groups.get(g)?.members ?? []), id] });
  }
  const directory: MessagingDirectory = { project: (id) => id === "p", agent: (id) => agents.get(id), group: (id) => groups.get(id), agents: () => [...agents.values()] };
  const runAgent = new Map<string, string>();
  const m = createMessagingBinding({
    journal: c.journal,
    audit: c.audit,
    random: { bytes: (n) => randomBytes(n) },
    monotonic: () => c.r.clock.monotonic(),
    scan: async () => [],
    directory,
    agentOf: (runId) => runAgent.get(runId),
    runLive: (runId) => c.journal.getRun(runId)?.state === "RUNNING",
    ...(options.maxText === undefined ? {} : { deliveryLimits: { maxText: options.maxText } }),
  });
  holder.m = m;
  return {
    c,
    m,
    agents,
    runAgent,
    run(agentId) {
      const id = c.journal.composer.createRun({ workspaceId: c.workspaceId, createdBy: "user" }, { mode: "agent", providerId: "mock", modelId: "mock-model" }).value.id;
      c.journal.transitionRun(id, "RUNNING");
      runAgent.set(id, agentId);
      return id;
    },
  };
}

/** The text blocks of the last user message of each provider request (what the model got at each boundary). */
export interface Driven {
  readonly end: Promise<LoopEnd>;
  readonly seen: string[][];
  /** The approval notes of the run (their previews carry the taint card). */
  readonly notes: ComposerApprovalNote[];
}

/** Run the real loop for `runId`: each reply is a list of tool calls; an empty list ends the run. */
export function drive(r: DeliveryRig, runId: string, replies: readonly (readonly { name: string; input: object }[])[], onTurn?: (n: number) => void): Driven {
  const seen: string[][] = [];
  const notes: ComposerApprovalNote[] = [];
  let i = 0;
  const end = (async (): Promise<LoopEnd> => {
    const tools = (await r.c.agent.prepare(r.c.workspaceId))({ runId, workspaceId: r.c.workspaceId, windowId: "win-1", mode: "agent", onApproval: (n) => void notes.push(n) });
    return runComposerLoop({
      runId, mode: "agent", prompt: "p", model: "mock-model", budget: createRunBudget({}), signal: new AbortController().signal, emit: () => undefined, tools,
      destination: { providerId: "mock", connectionId: "mock-connection", modelId: "mock-model", text: "Local" },
      provider: {
        generate: async (req): Promise<GenerateResult> => {
          seen.push((req.messages.at(-1)?.content ?? []).flatMap((b) => (b.type === "text" ? [b.text] : [])));
          onTurn?.(i);
          const calls = replies[i++] ?? [];
          return {
            model: "mock-model", usage: { inputTokens: 1, outputTokens: 1 }, stopReason: calls.length === 0 ? "end_turn" : "tool_use",
            content: calls.map((call, n) => ({ type: "tool_use" as const, id: `c${i}-${n}`, name: call.name, input: call.input as never })),
          };
        },
      },
    });
  })();
  return { end, seen, notes };
}

export const read = (path: string) => ({ name: "read_file", input: { path } });
export const write = (path: string, content = "x") => ({ name: "write_file", input: { path, content } });
