// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { ProviderErrorCode, ProviderError } from "./errors.js";
import { read } from "./guard-util.js";
import { ZERO_USAGE, type CostEstimate, type ProviderAdapter, type Usage } from "./types.js";
import type { ValidRequest } from "./validate.js";

/** Usage used to ask an adapter whether it can price a model at all, cache counters included (B2). */
export const PROBE_USAGE: Usage = { inputTokens: 1_000, outputTokens: 1_000, cacheReadTokens: 1_000, cacheWriteTokens: 1_000 };

/**
 * Errors that are pre-generation by definition: the provider refused the
 * request before producing anything, so nothing is charged (S5, NS3).
 */
export const NOT_BILLED: ReadonlySet<ProviderErrorCode> = new Set<ProviderErrorCode>([
  "invalid_request",
  "authentication",
  "permission_denied",
  "not_found",
  "rate_limited",
  "context_length_exceeded",
  "unsupported_capability",
]);

/**
 * Errors after which the provider may already have read the prompt (and, for
 * `generate`, generated): charged the input estimate when no output was seen,
 * in both paths (NS3). Anything else is charged input plus the output cap.
 */
export const INPUT_BILLED: ReadonlySet<ProviderErrorCode> = new Set<ProviderErrorCode>(["server_error", "overloaded"]);

/**
 * Codes only the guard may raise. An adapter that throws one (or `cancelled`
 * when nothing was cancelled) is misreporting, and gets `internal` (NS3).
 * `timeout` stays: adapters keep their own wire timeouts (ANT-1).
 */
export const GUARD_ONLY: ReadonlySet<ProviderErrorCode> = new Set<ProviderErrorCode>(["budget_exceeded", "secret_in_request", "cancelled"]);

/**
 * Budget hooks whose `recordUsage` failed. The guard refuses every later
 * request on them (`budget_exceeded`/`state_invalid`): spend that could not
 * be recorded must not be followed by more (S4, NN3).
 */
export const failedBudgets = new WeakSet<object>();

let requestSeq = 0;
export function nextRequestSeq(): number {
  requestSeq += 1;
  return requestSeq;
}

/** What `prepare` hands to the send path and to `charge`. */
export interface Prepared {
  readonly request: ValidRequest;
  readonly requestId: string | undefined;
  readonly estimatedInputTokens: number;
}

/** Pricing helpers bound to one adapter; each call reads `adapter.estimateCost` afresh. */
export function costing(adapter: ProviderAdapter): {
  safeCost: (model: string, usage: Usage) => CostEstimate | undefined;
  reserveCost: (model: string, inputTokens: number, outputTokens: number) => CostEstimate | undefined;
} {
  /** A validated cost, or undefined: NaN, negative, non-object or throwing estimates count as unpriced (B2). */
  const safeCost = (model: string, usage: Usage): CostEstimate | undefined => {
    if (adapter.estimateCost === undefined) return undefined;
    let c: unknown;
    try {
      c = adapter.estimateCost(model, usage);
    } catch {
      return undefined;
    }
    if (typeof c !== "object" || c === null) return undefined;
    const micro = read(c, "microUsd");
    if (typeof micro !== "number" || !Number.isFinite(micro) || micro < 0) return undefined;
    const rounded = Math.ceil(micro);
    return Number.isSafeInteger(rounded) ? { microUsd: rounded } : undefined;
  };

  /**
   * What to reserve for a request: the input priced at the higher of the plain
   * input rate and the cache-write rate (a request may write the prompt cache,
   * which providers bill at a premium), plus the output (R6). Undefined if
   * either price is unknown.
   */
  const reserveCost = (model: string, inputTokens: number, outputTokens: number): CostEstimate | undefined => {
    const plain = safeCost(model, { inputTokens, outputTokens });
    const cached = safeCost(model, { inputTokens: 0, outputTokens, cacheWriteTokens: inputTokens });
    if (plain === undefined || cached === undefined) return undefined;
    return plain.microUsd >= cached.microUsd ? plain : cached;
  };
  return { safeCost, reserveCost };
}

/**
 * What to charge for a request (S5, NS3, NN7):
 * - completed: the reported usage;
 * - never sent to the adapter: nothing;
 * - refused before any output with a pre-generation code: nothing;
 * - `server_error` or `overloaded` before any output: the input;
 * - anything else: the last reported input (or the estimate) plus the
 *   full output cap, or the reported output if it is higher.
 */
export const charge = (
  prep: Prepared,
  reported: Usage | undefined,
  complete: boolean,
  sawEvent: boolean,
  error: ProviderError | undefined,
  sent: boolean,
): [Usage, "reported" | "estimated" | "none"] => {
  if (complete && reported !== undefined) return [reported, "reported"];
  if (!sent) return [ZERO_USAGE, "none"];
  const input = reported?.inputTokens ?? prep.estimatedInputTokens;
  if (error !== undefined && !sawEvent) {
    if (NOT_BILLED.has(error.code)) return [ZERO_USAGE, "none"];
    if (INPUT_BILLED.has(error.code)) return [{ inputTokens: input, outputTokens: 0 }, "estimated"];
  }
  const u: { -readonly [K in keyof Usage]: Usage[K] } = {
    inputTokens: input,
    outputTokens: Math.max(reported?.outputTokens ?? 0, prep.request.maxOutputTokens),
  };
  if (reported?.cacheReadTokens !== undefined) u.cacheReadTokens = reported.cacheReadTokens;
  if (reported?.cacheWriteTokens !== undefined) u.cacheWriteTokens = reported.cacheWriteTokens;
  return [u, "estimated"];
};
