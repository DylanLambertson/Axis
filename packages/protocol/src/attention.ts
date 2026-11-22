// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { z } from "zod";
import { guarded } from "./guard.js";
import { agentIdSchema } from "./messages-wire.js";
import { projectIdSchema, type MethodSpec } from "./worktrees.js";

/**
 * `axis.attention/1` (ticket PV-D4, docs/design/product-vision-v2.md §3.4 "Needs attention"): what in one registered project
 * needs the user, as ids and counts only. No text, path, branch, reason, challenge or message content is ever in a reply,
 * and nothing here resolves anything: an approval is answered only through `axis.approvals/1` (ADR 0004 implication 4).
 *
 * Each count is computed when asked, over the project's live (`READY`) workspaces, and says whether it survives a daemon restart:
 *
 * | Field | From | Survives a restart |
 * |---|---|---|
 * | `approvalsWaiting` | live composer runs of the project waiting on a confirmation, per agent | no: LIVE only (a restart ends every composer loop, so it is 0 after one) |
 * | `failedRuns` | live workspaces whose newest run is `FAILED` | yes: DURABLE (journal) |
 * | `quietCliRuns` | CLI runs the daemon holds whose output went quiet (may be waiting for input) | no: LIVE only |
 * | `driftFlags` | live workspaces whose newest run is an ended CLI run with a post-run snapshot of `drift` or `unknown` | the verdict is held in memory; after a restart it is `unknown`, which counts (WT-2: possibly changed), so a restart keeps the flag. `pending` (snapshot still running) does not count yet. The flag clears when any newer run starts in the workspace |
 * | `unreadMessages` | messages to the user in the project's threads past the user's read cursor | yes: DURABLE (journal) |
 *
 * Not counted yet (a design follow-up): composer drift notices and Git-config flags, which have no stored record.
 */
export const ATTENTION_CONTRACT = "axis.attention" as const;
export const ATTENTION_VERSION = 1 as const;

/** A count stops here and says so: the home view shows "999+". */
export const ATTENTION_COUNT_CAP = 999;
/** Agents listed under `approvalsWaiting.byAgent`; more sets `more`. */
export const ATTENTION_MAX_AGENTS = 64;

/** A saturating count: `capped` when the true value is above the cap, or may be (then `n` is the cap: "999+"). */
export const attentionCountSchema = z
  .strictObject({ n: z.number().int().min(0).max(ATTENTION_COUNT_CAP), capped: z.boolean() })
  .refine((c) => !c.capped || c.n === ATTENTION_COUNT_CAP, "capped only at the cap");
export type AttentionCount = z.infer<typeof attentionCountSchema>;

export const attentionAgentCountSchema = z.strictObject({
  /** The agent the waiting runs were started for; null for runs started without one. */
  agentId: agentIdSchema.nullable(),
  n: z.number().int().min(1).max(ATTENTION_COUNT_CAP),
});

export const attentionSummaryRequestSchema = guarded(z.strictObject({ projectId: projectIdSchema }));
export const attentionSummaryResponseSchema = guarded(
  z.strictObject({
    projectId: projectIdSchema,
    approvalsWaiting: z
      .strictObject({
        total: attentionCountSchema,
        /** Null agent first, then by agent id; at most `ATTENTION_MAX_AGENTS` entries. */
        byAgent: z.array(attentionAgentCountSchema).max(ATTENTION_MAX_AGENTS),
        /** More agents have waiting runs than `byAgent` lists. */
        more: z.boolean(),
      })
      .refine((a) => new Set(a.byAgent.map((e) => e.agentId)).size === a.byAgent.length, "duplicate agent")
      .refine((a) => !a.more || a.byAgent.length === ATTENTION_MAX_AGENTS, "more only past a full list")
      .refine((a) => {
        // The listed agents add up to the total; with `more`, to less than it. A capped total is "999+": any listing fits it.
        const listed = a.byAgent.reduce((t, e) => t + e.n, 0);
        return a.total.capped || (a.more ? listed < a.total.n : listed === a.total.n);
      }, "the agents add up to the total"),
    failedRuns: attentionCountSchema,
    quietCliRuns: attentionCountSchema,
    driftFlags: attentionCountSchema,
    unreadMessages: attentionCountSchema,
  }),
);
export type AttentionSummary = z.infer<typeof attentionSummaryResponseSchema>;

/**
 * The handler's one refusal: `E_NOT_FOUND` for an unregistered project. A caller other than the user's desktop is refused
 * earlier, by policy (`E_POLICY_DENIED`), whatever the project id, so neither answer shows which projects exist; the handler's
 * own re-check of the caller answers `E_NOT_FOUND` too (defence in depth).
 */
export const ATTENTION_REFUSAL_MESSAGE = "The attention request was refused.";

export const attentionMethods = {
  summary: {
    request: attentionSummaryRequestSchema,
    response: attentionSummaryResponseSchema,
    sideEffect: "read",
    tier: 0,
    idempotency: "none",
    timeoutMs: 5_000,
  },
} as const satisfies Record<string, MethodSpec>;

export type AttentionMethod = keyof typeof attentionMethods;
export type AttentionRequest<M extends AttentionMethod> = z.infer<(typeof attentionMethods)[M]["request"]>;
export type AttentionResponse<M extends AttentionMethod> = z.infer<(typeof attentionMethods)[M]["response"]>;
