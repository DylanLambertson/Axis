// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { Journal } from "@axis/journal";
import type { UsageSummary, UsageTotalsWire } from "@axis/protocol";
import type { ComposerService } from "../composer/service.js";

/**
 * Usage, cost and budget left of one project (ticket PV-D3, `axis.usage/1.summary`, docs/design/product-vision-v2.md §3.4).
 * A read over the journal's J2 records: the project's totals, each listed worker's totals and what is left of its home
 * workspace's budget (C10, the limits the composer service enforces, passed in at composition). Ids and integers only.
 */
export type UsageTotalsRow = UsageTotalsWire;

export interface UsageServiceDeps {
  readonly projectExists: (projectId: string) => boolean;
  /** The project's listed (not archived) workers, at most 500 (`journal.agents.list`). */
  readonly agents: (projectId: string) => readonly { readonly id: string; readonly kind: "composer" | "cli"; readonly homeWorkspaceId: string }[];
  /** `journal.composer.projectUsage`: totals of every composer run of the project, and per worker id. */
  readonly usage: (projectId: string) => { readonly project: UsageTotalsRow; readonly byAgent: ReadonlyMap<string, UsageTotalsRow> };
  /** `journal.composer.workspaceBudget`: what the workspace's budget has counted so far. */
  readonly workspaceSpent: (workspaceId: string) => { readonly tokens: number; readonly costMicroUsd: number; readonly requests: number };
  /** The per-workspace budget limits the composer service enforces (unset: no limit). */
  readonly limits: { readonly maxTokens?: number; readonly maxCostMicroUsd?: number; readonly maxRequests?: number };
}

export interface UsageService {
  summary(projectId: string): UsageSummary;
}

/** The one refusal: the project is not registered. The handler answers it exactly as a refused caller. */
export class UsageRefusal extends Error {
  constructor() {
    super("usage refused");
    this.name = "UsageRefusal";
  }
}

const ZERO: UsageTotalsWire = Object.freeze({ runs: 0, inputTokens: 0, outputTokens: 0, tokens: 0, requests: 0, costMicroUsd: 0, unpricedRequests: 0 });
const FIELDS = Object.keys(ZERO) as (keyof UsageTotalsWire)[];

/** What is left under `limit`, floored at zero; null when there is no limit. */
export function remaining(limit: number | undefined, spent: number): number | null {
  return limit === undefined ? null : Math.max(0, limit - spent);
}

const copy = (t: UsageTotalsWire): UsageTotalsWire => Object.fromEntries(FIELDS.map((f) => [f, t[f]])) as unknown as UsageTotalsWire;

export function createUsageService(deps: UsageServiceDeps): UsageService {
  return {
    summary(projectId) {
      if (!deps.projectExists(projectId)) throw new UsageRefusal();
      const { project, byAgent } = deps.usage(projectId);
      const unattributed = Object.fromEntries(FIELDS.map((f) => [f, project[f]])) as Record<keyof UsageTotalsWire, number>;
      const agents = deps.agents(projectId).map((a) => {
        if (a.kind === "cli") return { agentId: a.id, kind: "cli" as const, usage: null, budgetRemaining: null };
        const usage = copy(byAgent.get(a.id) ?? ZERO);
        for (const f of FIELDS) unattributed[f] -= usage[f];
        const spent = deps.workspaceSpent(a.homeWorkspaceId);
        return {
          agentId: a.id,
          kind: "composer" as const,
          usage,
          budgetRemaining: {
            tokens: remaining(deps.limits.maxTokens, spent.tokens),
            requests: remaining(deps.limits.maxRequests, spent.requests),
            costMicroUsd: remaining(deps.limits.maxCostMicroUsd, spent.costMicroUsd),
          },
        };
      });
      return { projectId, project: copy(project), agents, unattributed };
    },
  };
}

/**
 * The service's dependencies as the host composes them (`compose-serving.ts` calls exactly this; review S-1): the project's
 * listed workers only (archived ones are not), the journal's totals and workspace spend, and the very limits object the
 * composer service enforces.
 */
export function usageServiceDeps(journal: Pick<Journal, "getProject" | "agents" | "composer">, composer: Pick<ComposerService, "workspaceLimits">): UsageServiceDeps {
  return {
    projectExists: (id) => journal.getProject(id) !== undefined,
    agents: (id) => journal.agents.list(id).map((a) => ({ id: a.id, kind: a.launch.kind, homeWorkspaceId: a.homeWorkspaceId })),
    usage: (id) => journal.composer.projectUsage(id),
    workspaceSpent: (id) => journal.composer.workspaceBudget(id),
    limits: composer.workspaceLimits,
  };
}
