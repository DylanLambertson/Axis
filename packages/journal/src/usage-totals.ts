// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { AxisError, type DatabaseSync } from "@axis/audit";

/**
 * Usage and cost of a project's composer runs (ticket PV-D3, `axis.usage/1`), from the J2 records (schema version 6): the
 * input and output tokens the provider last reported per run, and the run's budget totals (settled usage plus what requests in
 * flight reserved, so a request a dead process left in flight stays charged). Every composer run of every workspace the
 * project ever had counts, a removed workspace's included: money spent stays spent. CLI runs have no record here (ADR 0004
 * decision 8: Axis never reads a CLI's private stores).
 *
 * Integers only. SQLite's `sum` raises an error on 64-bit overflow, the totals are read as BigInt, and one above
 * `Number.MAX_SAFE_INTEGER` (2^53 - 1) is refused, so a total is exact or the read fails; it is never rounded.
 */
export interface UsageTotals {
  readonly runs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Budget tokens: input, output and cache tokens, settled plus reserved. */
  readonly tokens: number;
  readonly requests: number;
  /** Integer micro-USD of the requests that could be priced. */
  readonly costMicroUsd: number;
  /** Requests whose cost could not be estimated: `costMicroUsd` is a lower bound when this is not zero. */
  readonly unpricedRequests: number;
}

export interface ProjectUsage {
  readonly project: UsageTotals;
  /** Per agent id, for runs started for an agent (schema version 12); runs without one are in `project` only. */
  readonly byAgent: ReadonlyMap<string, UsageTotals>;
}

// `sum` (an integer, an error on 64-bit overflow), never `total` (a float, which would round a large value).
const SUMS = `count(*) AS runs, coalesce(sum(c.input_tokens), 0) AS input_tokens, coalesce(sum(c.output_tokens), 0) AS output_tokens,
  coalesce(sum(c.budget_tokens), 0) AS tokens, coalesce(sum(c.budget_requests), 0) AS requests,
  coalesce(sum(c.budget_cost_micro_usd), 0) AS cost, coalesce(sum(c.budget_unpriced), 0) AS unpriced`;
const FROM = `FROM composer_runs c JOIN agent_runs r ON r.id = c.run_id JOIN agent_workspaces w ON w.id = r.workspace_id
  WHERE w.project_id = ?`;

type Row = Record<string, unknown>;

/** A total read as a BigInt: exact up to 64 bits, then refused above `Number.MAX_SAFE_INTEGER` (never rounded). */
function int(v: unknown): number {
  if (typeof v !== "bigint" || v < 0n || v > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new AxisError("E_INTERNAL", "A usage total is out of range", { reason: "usage_range" });
  }
  return Number(v);
}

function toTotals(r: Row | undefined): UsageTotals {
  return {
    runs: int(r?.["runs"]),
    inputTokens: int(r?.["input_tokens"]),
    outputTokens: int(r?.["output_tokens"]),
    tokens: int(r?.["tokens"]),
    requests: int(r?.["requests"]),
    costMicroUsd: int(r?.["cost"]),
    unpricedRequests: int(r?.["unpriced"]),
  };
}

/** The project's totals and its per-agent totals. One aggregate each, through the indexed joins. */
export function readProjectUsage(db: DatabaseSync, projectId: string): ProjectUsage {
  const totals = db.prepare(`SELECT ${SUMS} ${FROM}`);
  totals.setReadBigInts(true);
  const project = toTotals(totals.get(projectId) as Row | undefined);
  const byAgent = new Map<string, UsageTotals>();
  const grouped = db.prepare(`SELECT r.agent_id AS agent_id, ${SUMS} ${FROM} AND r.agent_id IS NOT NULL GROUP BY r.agent_id`);
  grouped.setReadBigInts(true);
  const rows = grouped.all(projectId) as Row[];
  for (const row of rows) byAgent.set(String(row["agent_id"]), toTotals(row));
  return { project, byAgent };
}
