// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { z } from "zod";
import { MAX_AGENTS_PER_PROJECT } from "./agents.js";
import { countSchema, guarded } from "./guard.js";
import { agentIdSchema } from "./messages-wire.js";
import { projectIdSchema, type MethodSpec } from "./worktrees.js";

/**
 * `axis.usage/1` (ticket PV-D3, docs/design/product-vision-v2.md §3.4 "Usage and cost"): what one registered project's
 * composer runs used and cost, in total and per worker, and how much of each worker's workspace budget is left (PRV-6). A
 * different concern and a different payload class (money) from `axis.attention/1`, so a contract of its own.
 *
 * Integers only: tokens and requests as counts, cost as integer micro-USD (never a float or formatted text), all exact (the
 * daemon refuses a total above `Number.MAX_SAFE_INTEGER` rather than round it). No name, model id, provider id or path.
 * Every value is DURABLE: the journal's J2 records (composer runs) and C10 workspace budgets, so it survives a restart.
 *
 * - `project`: every composer run of every workspace the project ever had (money spent stays spent).
 * - `agents`: the project's listed (not archived) workers. A CLI worker's `usage` and `budgetRemaining` are null: not
 *   available (ADR 0004 decision 8: Axis never reads a CLI's private stores).
 * - `unattributed`: `project` minus the listed workers' totals: runs not attributed to a listed worker (runs started without
 *   one, and runs of an archived worker).
 * - `unpricedRequests` above zero means `costMicroUsd` is a lower bound (some requests could not be priced).
 */
export const USAGE_CONTRACT = "axis.usage" as const;
export const USAGE_VERSION = 1 as const;

export const usageTotalsSchema = z.strictObject({
  runs: countSchema,
  inputTokens: countSchema,
  outputTokens: countSchema,
  /** Budget tokens (input, output and cache), settled plus what requests in flight reserved. */
  tokens: countSchema,
  requests: countSchema,
  costMicroUsd: countSchema,
  unpricedRequests: countSchema,
});
export type UsageTotalsWire = z.infer<typeof usageTotalsSchema>;
const FIELDS = Object.keys(usageTotalsSchema.shape) as (keyof UsageTotalsWire)[];

/** What is left of the worker's home-workspace budget (C10), floored at zero; null where that budget sets no limit. */
export const budgetRemainingSchema = z.strictObject({
  tokens: countSchema.nullable(),
  requests: countSchema.nullable(),
  costMicroUsd: countSchema.nullable(),
});

export const agentUsageSchema = z
  .strictObject({
    agentId: agentIdSchema,
    kind: z.enum(["composer", "cli"]),
    usage: usageTotalsSchema.nullable(),
    budgetRemaining: budgetRemainingSchema.nullable(),
  })
  .refine((a) => (a.kind === "cli") === (a.usage === null) && (a.kind === "cli") === (a.budgetRemaining === null), "a CLI worker's usage is not available");

export const usageSummaryRequestSchema = guarded(z.strictObject({ projectId: projectIdSchema }));
export const usageSummaryResponseSchema = guarded(
  z
    .strictObject({
      projectId: projectIdSchema,
      project: usageTotalsSchema,
      agents: z.array(agentUsageSchema).max(MAX_AGENTS_PER_PROJECT),
      /** Not attributed to a listed worker: runs without a worker, and runs of an archived one. */
      unattributed: usageTotalsSchema,
    })
    .refine((r) => new Set(r.agents.map((a) => a.agentId)).size === r.agents.length, "duplicate worker")
    .refine(
      (r) => FIELDS.every((f) => r.unattributed[f] + r.agents.reduce((t, a) => t + (a.usage?.[f] ?? 0), 0) === r.project[f]),
      "the workers and the unattributed runs add up to the project",
    ),
);
export type UsageSummary = z.infer<typeof usageSummaryResponseSchema>;

/**
 * The handler's one refusal: `E_NOT_FOUND` for an unregistered project. A caller other than the user's desktop is refused
 * earlier, by policy (`E_POLICY_DENIED`), whatever the project id, so neither answer shows which projects exist; the handler's
 * own re-check of the caller answers `E_NOT_FOUND` too (defence in depth).
 */
export const USAGE_REFUSAL_MESSAGE = "The usage request was refused.";

export const usageMethods = {
  summary: {
    request: usageSummaryRequestSchema,
    response: usageSummaryResponseSchema,
    sideEffect: "read",
    tier: 0,
    idempotency: "none",
    timeoutMs: 5_000,
  },
} as const satisfies Record<string, MethodSpec>;

export type UsageMethod = keyof typeof usageMethods;
export type UsageRequest<M extends UsageMethod> = z.infer<(typeof usageMethods)[M]["request"]>;
export type UsageResponse<M extends UsageMethod> = z.infer<(typeof usageMethods)[M]["response"]>;
