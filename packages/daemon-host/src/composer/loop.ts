// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { ComposerMode } from "@axis/protocol";
import { isProviderError, type BudgetHook, type ContentBlock, type GuardedProvider, type Message, type Usage } from "@axis/providers";
import type { ComposerRunTools } from "../ports/composer.js";
import type { ActivityInput } from "./activity.js";

/**
 * The composer turn loop (docs/design/composer-runtime.md section 4). One provider request per turn through the guarded
 * provider, which asks the run's budget BEFORE every request (PRV-6): a refusal ends the run before the request is sent,
 * with the dimension as the reason. Every `tool_use` block goes through the run's tools (the broker, with its policy and
 * approvals), one at a time, and its result goes back to the model. The loop never sees a path, a credential or the
 * broker itself, and nothing it emits is model text that was not escaped by the activity store.
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
  readonly signal: AbortSignal;
  readonly emit: (event: ActivityInput) => void;
  readonly maxTurns?: number;
  readonly maxOutputTokens?: number;
  /** Most tool calls one model reply may make (review r1 S4). Default 16; a reply with more ends the run `TOOL_CALL_LIMIT`. */
  readonly maxToolCallsPerTurn?: number;
  /** Most characters of tool results a run may hand back to the model (S4). Default 4 Mi; past it the run ends `TOOL_RESULT_LIMIT`. */
  readonly maxResultChars?: number;
}

export const MAX_TOOL_CALLS_PER_TURN = 16;
export const MAX_RESULT_CHARS_PER_RUN = 4_194_304;

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
  const messages: Message[] = [{ role: "user", content: [{ type: "text", text: input.prompt }] }];
  let usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let requests = 0;
  const maxCalls = input.maxToolCallsPerTurn ?? MAX_TOOL_CALLS_PER_TURN;
  const maxResult = input.maxResultChars ?? MAX_RESULT_CHARS_PER_RUN;
  let resultChars = 0;
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
        { runId: input.runId, signal, budget: input.budget },
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
    // Bounded fan-out (S4): a reply that asks for more calls than the cap runs none of them; the memory a run holds stays bounded.
    if (calls.length > maxCalls) return { state: "FAILED", reason: "TOOL_CALL_LIMIT" };
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
      resultChars += outcome.content.length;
      // The call ran (and is audited), but its result is not kept: the run stops before it holds more than the cap (S4).
      if (resultChars > maxResult) return { state: "FAILED", reason: "TOOL_RESULT_LIMIT" };
      results.push({ type: "tool_result", toolUseId: call.id, content: outcome.content, ...(outcome.ok ? {} : { isError: true }) });
    }
    if (signal.aborted) return { state: "CANCELLED", reason: "USER_CANCELLED" };
    messages.push({ role: "user", content: results });
  }
  return { state: "FAILED", reason: "TURN_LIMIT" };
}

/** A model-chosen tool name as an event field: the broker's name rule, or a fixed word. */
function safeName(name: string): string {
  return /^[a-z][a-z0-9_.-]{0,63}$/.test(name) ? name : "unknown";
}
