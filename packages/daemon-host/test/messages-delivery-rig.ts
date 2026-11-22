// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { randomBytes } from "node:crypto";
import type { TestContext } from "node:test";
import type { Challenge } from "@axis/protocol";
import { createRunBudget, type GenerateResult } from "@axis/providers";
import { createMessagingBinding, runComposerLoop, type AgentEntry, type ComposerApprovalNote, type GroupEntry, type LoopEnd, type ToolCaps, type MessagingBinding, type MessagingDirectory, type MessagingLimits, type PreviewScanner } from "../src/index.js";
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
  /** Called after each delivery the binding asked for (to cancel a run right after its block was leased). */
  afterNext?: () => void;
  /** The codes of the failures the pipeline swallowed, in order. */
  readonly codes: string[];
}

export async function deliveryRig(t: TestContext, options: { maxText?: number; failTaintAudit?: () => boolean; limits?: Partial<MessagingLimits>; onInternalError?: (code: string) => void; messaging?: boolean; noDelivery?: boolean; previewScanner?: PreviewScanner; scan?: (text: string) => Promise<readonly unknown[]> } = {}): Promise<DeliveryRig> {
  const holder: { m?: MessagingBinding; rig?: DeliveryRig } = {};
  const agents = new Map<string, AgentEntry>();
  const groups = new Map<string, GroupEntry>();
  const directory: MessagingDirectory = { project: (id) => id === "p", agent: (id) => agents.get(id), group: (id) => groups.get(id), agents: () => [...agents.values()] };
  const runAgent = new Map<string, string>();
  const live = (): MessagingBinding => holder.m as MessagingBinding;
  const c = await composerRig({
    ...(options.previewScanner === undefined ? {} : { previewScanner: options.previewScanner }),
    // PV-M4: the run's `send_message` and `read_messages` over the same service (the binding is built first, so late-bound).
    ...(options.messaging === true
      ? { messaging: { service: { send: (who, req) => live().service.send(who, req), read: (who, req) => live().service.read(who, req) }, directory, agentOf: (runId: string) => runAgent.get(runId), random: { bytes: (n: number) => randomBytes(n) } } }
      : {}),
    replies: [],
    deliveries: {
      next: (runId, taint) => {
        if (options.noDelivery === true) return undefined;
        const out = holder.m?.delivery.next(runId, taint);
        holder.rig?.afterNext?.();
        return out;
      },
    },
    ...(options.failTaintAudit === undefined ? {} : { failAudit: (action: string) => action === "message.taint" && options.failTaintAudit?.() === true }),
  });
  t.after(() => c.cleanup());
  c.journal.registerProject({ id: "p", path: "/repo/p", displayName: "p", trusted: true, actor: "user" });
  for (const [id, g, kind] of [["a1", "g1", "composer"], ["a2", "g1", "composer"], ["c1", "g1", "cli"], ["b1", "g2", "composer"]] as const) {
    agents.set(id, { agentId: id, projectId: "p", groupId: g, kind });
    groups.set(g, { groupId: g, projectId: "p", members: [...(groups.get(g)?.members ?? []), id] });
  }
  const codes: string[] = [];
  const m = createMessagingBinding({
    journal: c.journal,
    audit: c.audit,
    random: { bytes: (n) => randomBytes(n) },
    monotonic: () => c.r.clock.monotonic(),
    scan: options.scan ?? (async () => []),
    directory,
    agentOf: (runId) => runAgent.get(runId),
    runLive: (runId) => c.journal.getRun(runId)?.state === "RUNNING",
    ...(options.maxText === undefined ? {} : { deliveryLimits: { maxText: options.maxText } }),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    onInternalError: (code) => {
      codes.push(code);
      options.onInternalError?.(code);
    },
  });
  holder.m = m;
  const rig: DeliveryRig = {
    c,
    m,
    codes,
    agents,
    runAgent,
    run(agentId) {
      const id = c.journal.composer.createRun({ workspaceId: c.workspaceId, createdBy: "user" }, { mode: "agent", providerId: "mock", modelId: "mock-model" }).value.id;
      c.journal.transitionRun(id, "RUNNING");
      runAgent.set(id, agentId);
      return id;
    },
  };
  holder.rig = rig;
  return rig;
}

/** The text blocks of the last user message of each provider request (what the model got at each boundary). */
export interface Driven {
  readonly end: Promise<LoopEnd>;
  readonly seen: string[][];
  /** The approval notes of the run (their previews carry the taint card). */
  readonly notes: ComposerApprovalNote[];
  /** The system prompt of each request. */
  readonly systems: string[];
  /** The tool results of the last user message of each request (what the model got back from its calls). */
  readonly results: string[][];
  /** The names of the tools each request offered. */
  readonly tools: string[][];
}

export interface DriveOptions {
  readonly onTurn?: (n: number) => void;
  readonly maxTurns?: number;
  readonly caps?: Partial<ToolCaps>;
  readonly signal?: AbortSignal;
  /** Request numbers (0-based) whose provider call fails. */
  readonly failRequests?: readonly number[];
}

/** Run the real loop for `runId`: each reply is a list of tool calls; an empty list ends the run. */
export function drive(r: DeliveryRig, runId: string, replies: readonly (readonly { name: string; input: object }[])[], o: DriveOptions = {}): Driven {
  const seen: string[][] = [];
  const systems: string[] = [];
  const notes: ComposerApprovalNote[] = [];
  const results: string[][] = [];
  const offered: string[][] = [];
  let i = 0;
  const end = (async (): Promise<LoopEnd> => {
    const tools = (await r.c.agent.prepare(r.c.workspaceId))({ runId, workspaceId: r.c.workspaceId, windowId: "win-1", mode: "agent", onApproval: (n) => void notes.push(n) });
    return runComposerLoop({
      runId, mode: "agent", prompt: "p", model: "mock-model", budget: createRunBudget({}), signal: o.signal ?? new AbortController().signal, emit: () => undefined, tools,
      ...(o.maxTurns === undefined ? {} : { maxTurns: o.maxTurns }),
      ...(o.caps === undefined ? {} : { caps: o.caps }),
      destination: { providerId: "mock", connectionId: "mock-connection", modelId: "mock-model", text: "Local" },
      provider: {
        generate: async (req): Promise<GenerateResult> => {
          seen.push((req.messages.at(-1)?.content ?? []).flatMap((b) => (b.type === "text" ? [b.text] : [])));
          systems.push(req.system ?? "");
          results.push((req.messages.at(-1)?.content ?? []).flatMap((b) => (b.type === "tool_result" ? [typeof b.content === "string" ? b.content : b.content.map((x) => x.text).join("")] : [])));
          offered.push((req.tools ?? []).map((x) => x.name));
          o.onTurn?.(i);
          if (o.failRequests?.includes(i)) {
            i++;
            throw new Error("the provider is down");
          }
          const calls = replies[i++] ?? [];
          return {
            model: "mock-model", usage: { inputTokens: 1, outputTokens: 1 }, stopReason: calls.length === 0 ? "end_turn" : "tool_use",
            content: calls.map((call, n) => ({ type: "tool_use" as const, id: `c${i}-${n}`, name: call.name, input: call.input as never })),
          };
        },
      },
    });
  })();
  return { end, seen, notes, systems, results, tools: offered };
}

export const read = (path: string) => ({ name: "read_file", input: { path } });
export const write = (path: string, content = "x") => ({ name: "write_file", input: { path, content } });

/** Approve every challenge of the run until it ends (tier `write`: the window's approval is enough). */
export async function approveAll(r: DeliveryRig, end: Promise<unknown>, decision: "approve" | "deny" = "approve"): Promise<number> {
  let done = false;
  void end.finally(() => (done = true));
  let n = 0;
  while (!done) {
    const pending = ((await r.c.user.call("axis.approvals", "pending", {})).result?.["challenges"] ?? []) as Challenge[];
    for (const ch of pending) {
      await r.c.user.call("axis.approvals", "resolve", { challengeId: ch.challengeId, decision, digest: ch.digest });
      n++;
    }
    await new Promise((res) => setTimeout(res, 10));
  }
  return n;
}

/** Deny every challenge of the run until it ends; the number denied (0 when the run never asked). */
export const denyAll = (r: DeliveryRig, end: Promise<unknown>): Promise<number> => approveAll(r, end, "deny");
