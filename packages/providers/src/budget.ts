// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { CostEstimate, Usage } from "./types.js";

/** What the guard tells the budget before a provider request (PRV-6). */
export interface BudgetRequestInfo {
  readonly runId: string;
  readonly providerId: string;
  readonly connectionId: string;
  readonly model: string;
  readonly maxOutputTokens: number;
  /** False when the adapter cannot price this model, so a cost cap cannot be enforced. */
  readonly costKnown: boolean;
}

export type BudgetDecision =
  | {
      readonly allow: true;
      /** Lower the request's output cap to this, so one request cannot overshoot far. */
      readonly maxOutputTokens?: number;
    }
  | {
      readonly allow: false;
      /** Fixed reason word, recorded on the run (`tokens`, `cost`, `requests`, `cost_unknown`). */
      readonly reason: string;
    };

export interface BudgetUsageInfo {
  readonly runId: string;
  readonly providerId: string;
  readonly connectionId: string;
  readonly model: string;
  readonly usage: Usage;
  /** Undefined when the adapter has no price for the model. */
  readonly cost: CostEstimate | undefined;
  /** How the request ended. Usage is recorded on failure and cancel too: tokens were billed. */
  readonly outcome: "completed" | "failed" | "cancelled";
}

/**
 * Per-run budget hook (PRV-6). The daemon owns the instance and its storage;
 * the guard calls `beforeRequest` before every provider request and stops the
 * run when it denies, and calls `recordUsage` after every request.
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
  state(): RunBudgetState;
}

/**
 * An in-memory per-run budget. The daemon persists `state()` in the run
 * journal and seeds it with `initial` after a restart.
 *
 * - Denies before the next request once a limit is reached (`>=`).
 * - Clamps `maxOutputTokens` to the token headroom, so a request can overshoot
 *   the token cap only by its input tokens.
 * - With a cost cap, refuses a model the adapter cannot price (`cost_unknown`):
 *   an unenforceable cap fails closed.
 */
export function createRunBudget(limits: RunBudgetLimits, initial?: Partial<RunBudgetState>): RunBudget {
  for (const [k, v] of Object.entries(limits)) {
    if (v !== undefined && (!Number.isSafeInteger(v) || v < 0)) throw new RangeError(`budget limit ${k} must be a non-negative integer`);
  }
  let tokens = initial?.tokens ?? 0;
  let costMicroUsd = initial?.costMicroUsd ?? 0;
  let requests = initial?.requests ?? 0;
  let unpricedRequests = initial?.unpricedRequests ?? 0;

  return {
    limits,
    state: () => ({ tokens, costMicroUsd, requests, unpricedRequests }),
    beforeRequest(info) {
      if (limits.maxRequests !== undefined && requests >= limits.maxRequests) return { allow: false, reason: "requests" };
      if (limits.maxTokens !== undefined && tokens >= limits.maxTokens) return { allow: false, reason: "tokens" };
      if (limits.maxCostMicroUsd !== undefined) {
        if (!info.costKnown) return { allow: false, reason: "cost_unknown" };
        if (costMicroUsd >= limits.maxCostMicroUsd) return { allow: false, reason: "cost" };
      }
      requests += 1;
      if (limits.maxTokens !== undefined) {
        const headroom = limits.maxTokens - tokens;
        if (headroom < info.maxOutputTokens) return { allow: true, maxOutputTokens: headroom };
      }
      return { allow: true };
    },
    recordUsage(info) {
      const u = info.usage;
      tokens += u.inputTokens + u.outputTokens + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0);
      if (info.cost === undefined) unpricedRequests += 1;
      else costMicroUsd += info.cost.microUsd;
    },
  };
}
