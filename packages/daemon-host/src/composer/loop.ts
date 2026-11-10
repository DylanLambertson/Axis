// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { ComposerMode } from "@axis/protocol";
import { isProviderError, type BudgetHook, type ContentBlock, type GuardedProvider, type Message, type Usage } from "@axis/providers";
import type { ComposerRunTools } from "../ports/composer.js";
import type { ActivityInput } from "./activity.js";
import { withDestinationEvents, type RequestDestination } from "./destination.js";

/**
 * The composer turn loop (docs/design/composer-runtime.md section 4). One provider request per turn through the guarded
 * provider, which asks the run's budget BEFORE every request (PRV-6): a refusal ends the run before the request is sent,
 * with the dimension as the reason. Every `tool_use` block goes through the run's tools (the broker, with its policy and
 * approvals), one at a time, and its result goes back to the model. The loop never sees a path, a credential or the
 * broker itself, and nothing it emits is model text that was not escaped by the activity store. Before each turn after
 * the first, the tools' drift notice (policies section 3.4, C2) is added after the tool results the model gets next.
 */

export type LoopEnd =
  | { readonly state: "REVIEWING"; readonly reason: null }
  | { readonly state: "FAILED"; readonly reason: string }
  | { readonly state: "CANCELLED"; readonly reason: "USER_CANCELLED" };

export interface LoopInput {
  readonly runId: string;
  readonly mode: ComposerMode;
  readonly prompt: string;
  readonly model: string;
  readonly provider: Pick<GuardedProvider, "generate">;
  /** Undefined in Ask mode: no tool is offered. */
  readonly tools: ComposerRunTools | undefined;
  readonly budget: BudgetHook;
  /** Where the provider's requests go; each allowed request is shown with it (PRV-4). */
  readonly destination: RequestDestination;
  readonly signal: AbortSignal;
  readonly emit: (event: ActivityInput) => void;
  readonly maxTurns?: number;
  readonly maxOutputTokens?: number;
  /** Fan-out caps (review r1 S4); each one unset takes its `DEFAULT_TOOL_CAPS` value. */
  readonly caps?: Partial<ToolCaps>;
}

/**
 * The fan-out caps of a run (review r1 S4). Counts, UTF-8 bytes and nesting depth of the tool calls a model asks for,
 * per reply and per run, and the bytes of what the calls hand back. The call caps are checked for the whole reply BEFORE
 * any of its calls runs (a reply over a cap runs none); the result caps after each call (it ran and is audited, but its
 * result is not kept). Exactly the cap is allowed. Each cap ends the run FAILED with its reason from `TOOL_LIMIT_REASONS`.
 */
export interface ToolCaps {
  /** Calls in one reply (`TOOL_CALL_LIMIT`). */
  readonly callsPerReply: number;
  /** Calls over the whole run (`TOOL_CALL_RUN_LIMIT`). */
  readonly callsPerRun: number;
  /** Nesting depth of one call's input; `{}` is 1 (`TOOL_INPUT_DEPTH`). */
  readonly inputDepth: number;
  /** UTF-8 bytes of the JSON inputs of one reply's calls (`TOOL_INPUT_LIMIT`). */
  readonly inputBytesPerReply: number;
  /** UTF-8 bytes of the JSON inputs over the run (`TOOL_INPUT_RUN_LIMIT`). */
  readonly inputBytesPerRun: number;
  /** UTF-8 bytes of the results of one reply's calls (`TOOL_RESULT_REPLY_LIMIT`). */
  readonly resultBytesPerReply: number;
  /** UTF-8 bytes of results over the run (`TOOL_RESULT_LIMIT`). */
  readonly resultBytesPerRun: number;
}

/**
 * Defaults: 16 calls a reply and 128 a run; inputs 8 deep, 2 MiB a reply (two full writes) and 8 MiB a run; results 1 MiB a
 * reply (four full reads) and 4 MiB a run. With at most 8 live runs the loops hold at most about 8 x (8 + 4) MiB of tool
 * traffic as UTF-8, twice that as UTF-16 strings.
 */
export const DEFAULT_TOOL_CAPS: ToolCaps = Object.freeze({
  callsPerReply: 16,
  callsPerRun: 128,
  inputDepth: 8,
  inputBytesPerReply: 2_097_152,
  inputBytesPerRun: 8_388_608,
  resultBytesPerReply: 1_048_576,
  resultBytesPerRun: 4_194_304,
});

/** The closed set of run reasons a cap ends a run with. */
export const TOOL_LIMIT_REASONS = [
  "TOOL_CALL_LIMIT",
  "TOOL_CALL_RUN_LIMIT",
  "TOOL_INPUT_DEPTH",
  "TOOL_INPUT_LIMIT",
  "TOOL_INPUT_RUN_LIMIT",
  "TOOL_RESULT_REPLY_LIMIT",
  "TOOL_RESULT_LIMIT",
] as const;
export type ToolLimitReason = (typeof TOOL_LIMIT_REASONS)[number];

/** Caps from the defaults and an override; an override that is not a positive safe integer is refused (fail closed, at configuration). */
export function resolveToolCaps(over: Partial<ToolCaps> = {}): ToolCaps {
  const out: Record<string, number> = { ...DEFAULT_TOOL_CAPS };
  for (const k of Object.keys(DEFAULT_TOOL_CAPS) as (keyof ToolCaps)[]) {
    const v = over[k];
    if (v === undefined) continue;
    if (!Number.isSafeInteger(v) || v < 1) throw new RangeError(`composer tool cap ${k} is out of range`);
    out[k] = v;
  }
  return Object.freeze(out as unknown as ToolCaps);
}

/** Nesting depth of a JSON value, counted up to `limit + 1` at most (the walk stops there). Scalars are 0. */
export function jsonDepth(value: unknown, limit: number): number {
  let max = 0;
  const stack: { readonly v: unknown; readonly d: number }[] = [{ v: value, d: 0 }];
  while (stack.length > 0) {
    const { v, d } = stack.pop() as { v: unknown; d: number };
    if (v === null || typeof v !== "object") continue;
    const depth = d + 1;
    if (depth > max) max = depth;
    if (max > limit) return max;
    for (const child of Array.isArray(v) ? v : Object.values(v as Record<string, unknown>)) stack.push({ v: child, d: depth });
  }
  return max;
}

const utf8 = (text: string): number => Buffer.byteLength(text, "utf8");

/** The reason the calls of one reply break a cap before any of them runs, or undefined. Anything unmeasurable breaks one. */
function checkCalls(calls: readonly { readonly input: unknown }[], caps: ToolCaps, used: { calls: number; inputBytes: number }): ToolLimitReason | undefined {
  if (calls.length > caps.callsPerReply) return "TOOL_CALL_LIMIT";
  if (used.calls + calls.length > caps.callsPerRun) return "TOOL_CALL_RUN_LIMIT";
  let bytes = 0;
  for (const call of calls) {
    if (jsonDepth(call.input, caps.inputDepth) > caps.inputDepth) return "TOOL_INPUT_DEPTH";
    let json: string | undefined;
    try {
      json = JSON.stringify(call.input);
    } catch {
      return "TOOL_INPUT_LIMIT";
    }
    bytes += utf8(json ?? "null");
  }
  if (bytes > caps.inputBytesPerReply) return "TOOL_INPUT_LIMIT";
  if (used.inputBytes + bytes > caps.inputBytesPerRun) return "TOOL_INPUT_RUN_LIMIT";
  used.calls += calls.length;
  used.inputBytes += bytes;
  return undefined;
}

const SYSTEM: Readonly<Record<ComposerMode, string>> = {
  ask: "You answer questions about the user's workspace. You have no tools.",
  edit: "You edit files in the user's workspace with the tools you are given. Every write is reviewed by the user.",
  agent: "You complete the user's task in their workspace with the tools you are given. Every change is reviewed by the user.",
};

/** A short upper-case run reason from a fixed word of the provider layer (`tokens`, `rate_limited`, ...). */
const upper = (word: string): string => word.toUpperCase().replace(/[^A-Z0-9_]/g, "_").slice(0, 40);

function failure(error: unknown, signal: AbortSignal): LoopEnd {
  if (signal.aborted) return { state: "CANCELLED", reason: "USER_CANCELLED" };
  if (isProviderError(error)) {
    if (error.code === "cancelled") return { state: "CANCELLED", reason: "USER_CANCELLED" };
    if (error.code === "budget_exceeded") return { state: "FAILED", reason: `BUDGET_${upper(error.details.reason ?? "denied")}` };
    return { state: "FAILED", reason: `PROVIDER_${upper(error.code)}` };
  }
  return { state: "FAILED", reason: "INTERNAL" };
}

const add = (a: Usage, b: Usage): Usage => ({ inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens });

export async function runComposerLoop(input: LoopInput): Promise<LoopEnd> {
  const { signal, emit, tools } = input;
  const maxTurns = input.maxTurns ?? 24;
  const budget = withDestinationEvents(input.budget, input.destination, emit);
  const messages: Message[] = [{ role: "user", content: [{ type: "text", text: input.prompt }] }];
  let usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let requests = 0;
  const caps = resolveToolCaps(input.caps);
  const used = { calls: 0, inputBytes: 0, resultBytes: 0 };
  for (let turn = 0; turn < maxTurns; turn++) {
    if (signal.aborted) return { state: "CANCELLED", reason: "USER_CANCELLED" };
    let result;
    try {
      result = await input.provider.generate(
        {
          model: input.model,
          system: SYSTEM[input.mode],
          messages,
          ...(tools === undefined || tools.specs.length === 0 ? {} : { tools: tools.specs.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) }),
          maxOutputTokens: input.maxOutputTokens ?? 4096,
        },
        { runId: input.runId, signal, budget },
      );
    } catch (e) {
      return failure(e, signal);
    }
    requests += 1;
    usage = add(usage, result.usage);
    emit({ type: "usage", usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, requests } });
    for (const block of result.content) if (block.type === "text" && block.text.length > 0) emit({ type: "text", text: block.text });
    if (result.stopReason === "refusal") return { state: "FAILED", reason: "MODEL_REFUSAL" };
    const calls = result.content.filter((b) => b.type === "tool_use");
    if (calls.length === 0) return { state: "REVIEWING", reason: null };
    // Bounded fan-out (S4): a reply that breaks a call cap runs none of its calls; the memory a run holds stays bounded.
    const over = checkCalls(calls, caps, used);
    if (over !== undefined) return { state: "FAILED", reason: over };
    let replyBytes = 0;
    messages.push({ role: "assistant", content: result.content.map((b) => b as ContentBlock) });
    const results: ContentBlock[] = [];
    for (const call of calls) {
      if (signal.aborted) return { state: "CANCELLED", reason: "USER_CANCELLED" };
      if (tools === undefined) {
        emit({ type: "tool", tool: safeName(call.name), outcome: "error", reason: "no_tools" });
        results.push({ type: "tool_result", toolUseId: call.id, content: "No tools are available in this mode.", isError: true });
        continue;
      }
      let outcome;
      try {
        outcome = await tools.invoke(call.name, call.input, signal);
      } catch {
        // The broker could not record what it did (audit): stop the run, never continue past an unrecorded side effect.
        return signal.aborted ? { state: "CANCELLED", reason: "USER_CANCELLED" } : { state: "FAILED", reason: "TOOL_FAILED" };
      }
      emit({ type: "tool", tool: safeName(call.name), outcome: outcome.ok ? "ok" : "error", reason: outcome.ok ? null : outcome.reason });
      const bytes = utf8(outcome.content);
      replyBytes += bytes;
      used.resultBytes += bytes;
      // The call ran (and is audited), but its result is not kept: the run stops before it holds more than a cap (S4).
      if (replyBytes > caps.resultBytesPerReply) return { state: "FAILED", reason: "TOOL_RESULT_REPLY_LIMIT" };
      if (used.resultBytes > caps.resultBytesPerRun) return { state: "FAILED", reason: "TOOL_RESULT_LIMIT" };
      results.push({ type: "tool_result", toolUseId: call.id, content: outcome.content, ...(outcome.ok ? {} : { isError: true }) });
    }
    if (signal.aborted) return { state: "CANCELLED", reason: "USER_CANCELLED" };
    // Drift before the next turn: what changed outside the run since this one, as context next to the tool results.
    const notice = await tools?.drift?.(signal).catch(() => undefined);
    if (signal.aborted) return { state: "CANCELLED", reason: "USER_CANCELLED" };
    messages.push({ role: "user", content: notice === undefined ? results : [...results, { type: "text", text: notice }] });
  }
  return { state: "FAILED", reason: "TURN_LIMIT" };
}

/** A model-chosen tool name as an event field: the broker's name rule, or a fixed word. */
function safeName(name: string): string {
  return /^[a-z][a-z0-9_.-]{0,63}$/.test(name) ? name : "unknown";
}
