// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { BudgetTotals } from "@axis/journal";
import type { BudgetDecision, BudgetHook, BudgetRequestInfo, BudgetUsageInfo, RunBudget } from "@axis/providers";

/**
 * The composer's budget hook (PRV-6, tickets J2 and C10): the run's budget is asked first, then the workspace's, and a
 * request goes out only when both allow it. Every allowance and every settlement is written to the journal before the
 * guard is answered, as the totals of both budgets INCLUDING what requests in flight reserved, so a process killed
 * mid-request leaves that request charged and a restart can never hand a run or a workspace a fresh budget.
 *
 * Closed: a refusal carries a reason from `BUDGET_REASONS` (the workspace's prefixed `workspace_`); any other answer,
 * a hook that throws or a journal write that fails denies with `state_invalid`, and every later request is denied too.
 */

/** The reasons a refusal can carry; the run ends `BUDGET_<REASON>` in upper case. */
export const BUDGET_REASONS = [
  "tokens", "cost", "requests", "cost_unknown", "state_invalid",
  "workspace_tokens", "workspace_cost", "workspace_requests", "workspace_cost_unknown", "workspace_state_invalid",
] as const;
const RUN_REASONS: ReadonlySet<string> = new Set(BUDGET_REASONS.filter((r) => !r.startsWith("workspace_")));

export interface ComposerBudgetDeps {
  readonly run: RunBudget;
  readonly workspace: RunBudget;
  /** Durable write of both totals (one transaction). Throws when it cannot write. */
  readonly save: (run: BudgetTotals, workspace: BudgetTotals) => void;
}

/** Settled totals plus the reservations of requests in flight: what the journal holds. */
export function durableTotals(b: RunBudget): BudgetTotals {
  const s = b.state();
  const r = b.reserved();
  return { tokens: s.tokens + r.tokens, costMicroUsd: s.costMicroUsd + r.costMicroUsd, requests: s.requests, unpricedRequests: s.unpricedRequests };
}

const DENY: BudgetDecision = Object.freeze({ allow: false, reason: "state_invalid" });

/** Release a reservation the guard will never settle (the request was refused after the run budget allowed it). */
function release(b: RunBudget, info: BudgetRequestInfo): void {
  try {
    void b.recordUsage({
      requestId: info.requestId, runId: info.runId, providerId: info.providerId, connectionId: info.connectionId, model: info.model,
      usage: { inputTokens: 0, outputTokens: 0 }, charged: "none", cost: undefined, outcome: "cancelled",
    });
  } catch {
    // the hook is poisoned below; nothing else to undo
  }
}

const allowed = (d: unknown): d is { allow: true; maxOutputTokens?: number } =>
  typeof d === "object" && d !== null && (d as { allow?: unknown }).allow === true &&
  ((d as { maxOutputTokens?: unknown }).maxOutputTokens === undefined || Number.isSafeInteger((d as { maxOutputTokens?: unknown }).maxOutputTokens));
const reasonOf = (d: unknown): string | undefined => {
  if (typeof d !== "object" || d === null || (d as { allow?: unknown }).allow !== false) return undefined;
  const r = (d as { reason?: unknown }).reason;
  return typeof r === "string" && RUN_REASONS.has(r) ? r : undefined;
};

export function createComposerBudget(deps: ComposerBudgetDeps): BudgetHook {
  let poisoned = false;
  const save = (): void => deps.save(durableTotals(deps.run), durableTotals(deps.workspace));

  return {
    async beforeRequest(info) {
      if (poisoned) return DENY;
      let first: unknown;
      try {
        first = await deps.run.beforeRequest(info);
      } catch {
        poisoned = true;
        return DENY;
      }
      if (!allowed(first)) {
        const reason = reasonOf(first);
        if (reason === undefined) poisoned = true;
        return { allow: false, reason: reason ?? "state_invalid" };
      }
      const cap = first.maxOutputTokens ?? info.maxOutputTokens;
      let second: unknown;
      try {
        second = await deps.workspace.beforeRequest({ ...info, maxOutputTokens: cap });
      } catch {
        second = undefined;
      }
      if (!allowed(second)) {
        release(deps.run, info);
        const reason = reasonOf(second);
        if (reason === undefined) poisoned = true;
        return { allow: false, reason: `workspace_${reason ?? "state_invalid"}` };
      }
      try {
        save();
      } catch {
        release(deps.run, info);
        release(deps.workspace, info);
        poisoned = true;
        return DENY;
      }
      const out = Math.min(cap, second.maxOutputTokens ?? cap);
      return out < info.maxOutputTokens ? { allow: true, maxOutputTokens: out } : { allow: true };
    },

    async recordUsage(info: BudgetUsageInfo) {
      try {
        await deps.run.recordUsage(info);
        await deps.workspace.recordUsage(info);
        save();
      } catch (e) {
        // The guard turns this into `internal` and refuses the run's later requests; so does this hook.
        poisoned = true;
        throw e;
      }
    },
  };
}
