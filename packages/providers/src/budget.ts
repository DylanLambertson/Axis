// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { CostEstimate, Usage } from "./types.js";

/** What the guard tells the budget before a provider request (PRV-6). */
export interface BudgetRequestInfo {
  /** Unique per request; `recordUsage` repeats it so a reservation can be settled. */
  readonly requestId: string;
  readonly runId: string;
  readonly providerId: string;
  readonly connectionId: string;
  readonly model: string;
  readonly maxOutputTokens: number;
  /** A deliberately high local estimate of the input tokens. */
  readonly estimatedInputTokens: number;
  /** False when the adapter cannot price this model, so a cost cap cannot be enforced. */
  readonly costKnown: boolean;
  /** Cost of `estimatedInputTokens` plus `maxOutputTokens`; undefined when unpriced. */
  readonly worstCaseCost: CostEstimate | undefined;
}

export type BudgetDecision =
  | {
      readonly allow: true;
      /** Lower the request's output cap to this, so one request cannot overshoot far. */
      readonly maxOutputTokens?: number;
    }
  | {
      readonly allow: false;
      /** Fixed reason word, recorded on the run (`tokens`, `cost`, `requests`, `cost_unknown`, `state_invalid`). */
      readonly reason: string;
    };

export interface BudgetUsageInfo {
  /** The id from `beforeRequest`. */
  readonly requestId: string;
  readonly runId: string;
  readonly providerId: string;
  readonly connectionId: string;
  readonly model: string;
  /**
   * Tokens to charge. When the provider never reported final usage (timeout,
   * cancel, failure mid-response) the guard charges a conservative amount
   * (`charged: "estimated"`): the input estimate plus the output cap.
   */
  readonly usage: Usage;
  readonly charged: "reported" | "estimated" | "none";
  /** Undefined when the adapter has no valid price for the model. */
  readonly cost: CostEstimate | undefined;
  /** How the request ended. Usage is recorded on failure and cancel too: tokens were billed. */
  readonly outcome: "completed" | "failed" | "cancelled";
}

/**
 * Per-run budget hook (PRV-6). The daemon owns the instance and its storage;
 * the guard calls `beforeRequest` before every provider request and stops the
 * run when it denies, and calls `recordUsage` exactly once for every request
 * it allowed, including requests refused afterwards (zero usage, which
 * releases the reservation).
 *
 * - If `recordUsage` cannot persist, the hook must deny the next
 *   `beforeRequest` (fail closed); the guard reports the failure as
 *   `internal` and does not retry the write.
 * - Per-workspace budgets (PRV-6) compose in the daemon: a hook that asks the
 *   run budget and then the workspace budget, and allows only if both do.
 */
export interface BudgetHook {
  beforeRequest(info: BudgetRequestInfo): BudgetDecision | Promise<BudgetDecision>;
  recordUsage(info: BudgetUsageInfo): void | Promise<void>;
}

export interface RunBudgetLimits {
  /** Input, output and cache tokens across the run. */
  readonly maxTokens?: number;
  /** Integer micro-USD across the run. */
  readonly maxCostMicroUsd?: number;
  readonly maxRequests?: number;
}

export interface RunBudgetState {
  readonly tokens: number;
  readonly costMicroUsd: number;
  readonly requests: number;
  /** Requests whose cost could not be estimated. */
  readonly unpricedRequests: number;
}

export interface RunBudget extends BudgetHook {
  readonly limits: RunBudgetLimits;
  /** Settled totals, for the run journal. Reservations of in-flight requests are not included. */
  state(): RunBudgetState;
  /** Tokens and cost reserved by requests still in flight. */
  reserved(): { readonly tokens: number; readonly costMicroUsd: number; readonly requests: number };
}

function isCount(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

/**
 * An in-memory per-run budget. The daemon persists `state()` in the run
 * journal and seeds it with `initial` after a restart.
 *
 * - Denies before the next request once a limit is reached (`>=`), counting
 *   the reservations of requests still in flight, so concurrent requests
 *   cannot overshoot the token cap (S6).
 * - Reserves the input estimate plus the (clamped) output cap per request,
 *   and clamps `maxOutputTokens` to the headroom left after that.
 * - With a cost cap, refuses a model the adapter cannot price, and refuses
 *   every request after one whose cost could not be estimated (`cost_unknown`):
 *   an unenforceable cap fails closed (B2).
 * - Usage or a journal state that is not a non-negative safe integer poisons
 *   the budget: every later request is denied (`state_invalid`).
 */
export function createRunBudget(limits: RunBudgetLimits, initial?: Partial<RunBudgetState>): RunBudget {
  for (const [k, v] of Object.entries(limits)) {
    if (v !== undefined && !isCount(v)) throw new RangeError(`budget limit ${k} must be a non-negative safe integer`);
  }
  for (const [k, v] of Object.entries(initial ?? {})) {
    if (v !== undefined && !isCount(v)) throw new RangeError(`budget state ${k} must be a non-negative safe integer`);
  }
  let tokens = initial?.tokens ?? 0;
  let costMicroUsd = initial?.costMicroUsd ?? 0;
  let requests = initial?.requests ?? 0;
  let unpricedRequests = initial?.unpricedRequests ?? 0;
  let poisoned = false;
  const reservations = new Map<string, { tokens: number; cost: number }>();

  const reservedTokens = (): number => [...reservations.values()].reduce((n, r) => n + r.tokens, 0);
  const reservedCost = (): number => [...reservations.values()].reduce((n, r) => n + r.cost, 0);
  const add = (a: number, b: number): number => {
    const s = a + b;
    if (!Number.isSafeInteger(s)) poisoned = true;
    return s;
  };

  return {
    limits,
    state: () => ({ tokens, costMicroUsd, requests, unpricedRequests }),
    reserved: () => ({ tokens: reservedTokens(), costMicroUsd: reservedCost(), requests: reservations.size }),

    beforeRequest(info) {
      if (poisoned) return { allow: false, reason: "state_invalid" };
      if (!isCount(info.maxOutputTokens) || !isCount(info.estimatedInputTokens) || reservations.has(info.requestId)) {
        return { allow: false, reason: "state_invalid" };
      }
      if (limits.maxRequests !== undefined && requests >= limits.maxRequests) return { allow: false, reason: "requests" };

      let maxOutputTokens = info.maxOutputTokens;
      if (limits.maxTokens !== undefined) {
        const used = tokens + reservedTokens();
        if (used >= limits.maxTokens) return { allow: false, reason: "tokens" };
        const headroom = limits.maxTokens - used - info.estimatedInputTokens;
        if (headroom < 1) return { allow: false, reason: "tokens" };
        maxOutputTokens = Math.min(maxOutputTokens, headroom);
      }

      let cost = 0;
      if (limits.maxCostMicroUsd !== undefined) {
        if (!info.costKnown || unpricedRequests > 0) return { allow: false, reason: "cost_unknown" };
        const worst = info.worstCaseCost?.microUsd;
        if (!isCount(worst)) return { allow: false, reason: "cost_unknown" };
        if (costMicroUsd + reservedCost() >= limits.maxCostMicroUsd) return { allow: false, reason: "cost" };
        cost = worst;
      }

      requests += 1;
      reservations.set(info.requestId, { tokens: info.estimatedInputTokens + maxOutputTokens, cost });
      return maxOutputTokens < info.maxOutputTokens ? { allow: true, maxOutputTokens } : { allow: true };
    },

    recordUsage(info) {
      reservations.delete(info.requestId);
      const u = info.usage;
      const parts = [u.inputTokens, u.outputTokens, u.cacheReadTokens ?? 0, u.cacheWriteTokens ?? 0];
      if (!parts.every(isCount)) {
        poisoned = true;
        return;
      }
      for (const p of parts) tokens = add(tokens, p);
      const c = info.cost?.microUsd;
      if (info.charged !== "none" && !isCount(c)) unpricedRequests += 1;
      else if (isCount(c)) costMicroUsd = add(costMicroUsd, c);
    },
  };
}
