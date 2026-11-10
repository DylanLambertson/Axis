// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { AxisError, isWellFormedString, withTransaction, type DatabaseSync } from "@axis/audit";
import { z } from "zod";
import { invalid, type CreateRunInput, type Created, type Run } from "./model.js";

/**
 * Composer run records (schema version 6, tickets J2 and C10; docs/design/composer-runtime.md section 4). What a run was
 * started with, its usage, its budget totals, the per-workspace budget totals and a bounded copy of its activity, so
 * `axis.runs/1.get` and `events` answer after a restart and a budget is seeded from here, never from zero.
 *
 * The store keeps what it is given: the host hands it display-safe, redacted events (no secret, no provider body).
 * It checks shapes and sizes, and enforces the bounds: per run and in total, by rows and by bytes, oldest first.
 */

export const COMPOSER_RUN_MODES = ["ask", "edit", "agent"] as const;
export const ACTIVITY_TYPES = ["state", "text", "tool", "approval", "usage", "request"] as const;
/** Longest stored event body, in UTF-8 bytes (the table refuses a longer one). */
export const MAX_ACTIVITY_ROW_BYTES = 65_536;

export interface ComposerRunMeta {
  readonly mode: (typeof COMPOSER_RUN_MODES)[number];
  readonly providerId: string;
  readonly modelId: string;
}
export interface ComposerUsageRecord {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly requests: number;
}
/** Budget totals as `@axis/providers` `RunBudgetState`: settled usage plus what requests in flight reserved. */
export interface BudgetTotals {
  readonly tokens: number;
  readonly costMicroUsd: number;
  readonly requests: number;
  readonly unpricedRequests: number;
}
export interface ComposerRunRecord extends ComposerRunMeta {
  readonly runId: string;
  readonly usage: ComposerUsageRecord | null;
  readonly budget: BudgetTotals;
  /** The last sequence number appended (0 before any). Evicted rows keep it. */
  readonly lastSeq: number;
  readonly activityRows: number;
  readonly activityBytes: number;
}
export type ActivityType = (typeof ACTIVITY_TYPES)[number];
export interface ActivityRecord {
  readonly seq: number;
  readonly at: string;
  readonly type: ActivityType;
  /** The event as JSON text, `type` included, `seq` and `at` left out. */
  readonly body: string;
}
/** Bounds of the stored activity. Per run: the oldest non-`request` row goes first; in total: rows of finished runs first. */
export interface ActivityBounds {
  readonly maxRunRows: number;
  readonly maxRunBytes: number;
  readonly maxRows: number;
  readonly maxBytes: number;
}
export const DEFAULT_ACTIVITY_BOUNDS: ActivityBounds = Object.freeze({
  maxRunRows: 1000,
  maxRunBytes: 1_048_576,
  maxRows: 50_000,
  maxBytes: 33_554_432,
});

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positive = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const runId = z.string().min(1).max(128).refine((s) => !/[\u0000-\u001f\u007f]/.test(s)).refine(isWellFormedString);
const metaSchema = z.strictObject({
  mode: z.enum(COMPOSER_RUN_MODES),
  providerId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  modelId: z.string().min(1).max(256).regex(/^[\x21-\x7e]+$/),
});
const usageSchema = z.strictObject({ inputTokens: count, outputTokens: count, requests: count });
const totalsSchema = z.strictObject({ tokens: count, costMicroUsd: count, requests: count, unpricedRequests: count });
const boundsSchema = z.strictObject({ maxRunRows: positive, maxRunBytes: positive, maxRows: positive, maxBytes: positive });
const recordSchema = z.strictObject({
  seq: positive,
  at: z.string().min(1).max(64).regex(/^[\x21-\x7e]+$/),
  type: z.enum(ACTIVITY_TYPES),
  body: z.string().refine(isWellFormedString),
});

const parse = <T>(schema: z.ZodType<T>, value: unknown, what: string): T => {
  const r = schema.safeParse(value);
  if (!r.success) throw invalid(r.error, what);
  return r.data;
};
const ZERO: BudgetTotals = Object.freeze({ tokens: 0, costMicroUsd: 0, requests: 0, unpricedRequests: 0 });

interface RunRow {
  run_id: string;
  mode: ComposerRunMeta["mode"];
  provider_id: string;
  model_id: string;
  input_tokens: number | null;
  output_tokens: number | null;
  usage_requests: number | null;
  budget_tokens: number;
  budget_cost_micro_usd: number;
  budget_requests: number;
  budget_unpriced: number;
  last_seq: number;
  activity_rows: number;
  activity_bytes: number;
}

/** Throws `E_INVALID_ARGUMENT` for bounds that are not positive safe integers (the host checks them when it is built). */
export function checkActivityBounds(bounds: ActivityBounds): ActivityBounds {
  return parse(boundsSchema, bounds, "activity bounds");
}

export class ComposerRecords {
  readonly #db: DatabaseSync;
  readonly #ts: () => string;
  readonly #createRun: (input: CreateRunInput) => Created<Run>;

  constructor(db: DatabaseSync, ts: () => string, createRun: (input: CreateRunInput) => Created<Run>) {
    this.#db = db;
    this.#ts = ts;
    this.#createRun = createRun;
  }

  /** `Journal.createRun` for a composer run and its record, in one transaction. A replay returns the earlier run as it is. */
  createRun(input: Omit<CreateRunInput, "kind">, meta: ComposerRunMeta): Created<Run> {
    const m = parse(metaSchema, meta, "composer run");
    return withTransaction(this.#db, () => {
      const created = this.#createRun({ ...input, kind: "composer" });
      if (created.replayed) return created;
      this.#db
        .prepare("INSERT INTO composer_runs (run_id, mode, provider_id, model_id, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(created.value.id, m.mode, m.providerId, m.modelId, this.#ts());
      return created;
    });
  }

  get(id: string): ComposerRunRecord | undefined {
    const row = this.#db.prepare("SELECT * FROM composer_runs WHERE run_id = ?").get(parse(runId, id, "run id")) as RunRow | undefined;
    if (row === undefined) return undefined;
    return {
      runId: row.run_id,
      mode: row.mode,
      providerId: row.provider_id,
      modelId: row.model_id,
      usage: row.input_tokens === null ? null : { inputTokens: row.input_tokens, outputTokens: row.output_tokens as number, requests: row.usage_requests as number },
      budget: { tokens: row.budget_tokens, costMicroUsd: row.budget_cost_micro_usd, requests: row.budget_requests, unpricedRequests: row.budget_unpriced },
      lastSeq: row.last_seq,
      activityRows: row.activity_rows,
      activityBytes: row.activity_bytes,
    };
  }

  recordUsage(id: string, usage: ComposerUsageRecord): void {
    const r = parse(runId, id, "run id");
    const u = parse(usageSchema, usage, "usage");
    withTransaction(this.#db, () =>
      one(this.#db.prepare("UPDATE composer_runs SET input_tokens = ?, output_tokens = ?, usage_requests = ? WHERE run_id = ?").run(u.inputTokens, u.outputTokens, u.requests, r)),
    );
  }

  /** The run's and its workspace's budget totals, together. The run must be a composer run of that workspace. */
  recordBudget(id: string, workspaceId: string, run: BudgetTotals, workspace: BudgetTotals): void {
    const r = parse(runId, id, "run id");
    const w = parse(runId, workspaceId, "workspace id");
    const rt = parse(totalsSchema, run, "run budget");
    const wt = parse(totalsSchema, workspace, "workspace budget");
    withTransaction(this.#db, () => {
      const owner = this.#db.prepare("SELECT workspace_id FROM agent_runs WHERE id = ?").get(r) as { workspace_id: string } | undefined;
      if (owner?.workspace_id !== w) throw new AxisError("E_CONFLICT", "The run does not belong to that workspace");
      one(
        this.#db
          .prepare("UPDATE composer_runs SET budget_tokens = ?, budget_cost_micro_usd = ?, budget_requests = ?, budget_unpriced = ? WHERE run_id = ?")
          .run(rt.tokens, rt.costMicroUsd, rt.requests, rt.unpricedRequests, r),
      );
      this.#db
        .prepare(
          "INSERT INTO composer_workspace_budgets (workspace_id, tokens, cost_micro_usd, requests, unpriced, updated_at) VALUES (?, ?, ?, ?, ?, ?) " +
            "ON CONFLICT (workspace_id) DO UPDATE SET tokens = excluded.tokens, cost_micro_usd = excluded.cost_micro_usd, " +
            "requests = excluded.requests, unpriced = excluded.unpriced, updated_at = excluded.updated_at",
        )
        .run(w, wt.tokens, wt.costMicroUsd, wt.requests, wt.unpricedRequests, this.#ts());
    });
  }

  /** The workspace's budget totals so far; zero for a workspace no composer run has charged. */
  workspaceBudget(workspaceId: string): BudgetTotals {
    const row = this.#db
      .prepare("SELECT tokens, cost_micro_usd, requests, unpriced FROM composer_workspace_budgets WHERE workspace_id = ?")
      .get(parse(runId, workspaceId, "workspace id")) as { tokens: number; cost_micro_usd: number; requests: number; unpriced: number } | undefined;
    return row === undefined ? ZERO : { tokens: row.tokens, costMicroUsd: row.cost_micro_usd, requests: row.requests, unpricedRequests: row.unpriced };
  }

  /**
   * Append one event and evict to the bounds, in one transaction. A body over `MAX_ACTIVITY_ROW_BYTES` is not stored
   * (`too_large`). Eviction never removes the event just appended, nor the newest event of any run still QUEUED or
   * RUNNING, so a stored total can exceed a total bound by at most one row per live run.
   */
  append(id: string, record: ActivityRecord, bounds: ActivityBounds = DEFAULT_ACTIVITY_BOUNDS): "stored" | "too_large" {
    const r = parse(runId, id, "run id");
    const rec = parse(recordSchema, record, "activity");
    const b = checkActivityBounds(bounds);
    if (Buffer.byteLength(rec.body, "utf8") > MAX_ACTIVITY_ROW_BYTES) return "too_large";
    withTransaction(this.#db, () => {
      const added = this.#db.prepare("INSERT INTO composer_activity (run_id, seq, type, at, body) VALUES (?, ?, ?, ?, ?)").run(r, rec.seq, rec.type, rec.at, rec.body);
      const kept = Number(added.lastInsertRowid);
      this.#evictRun(r, b);
      this.#evictTotal(b, kept);
    });
    return "stored";
  }

  /** Stored events after `afterSeq`, oldest first, at most `limit`. */
  read(id: string, afterSeq: number, limit: number): ActivityRecord[] {
    const r = parse(runId, id, "run id");
    const after = parse(count, afterSeq, "cursor");
    const n = parse(positive.max(1000), limit, "limit");
    return (this.#db.prepare("SELECT seq, at, type, body FROM composer_activity WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?").all(r, after, n) as unknown as ActivityRecord[]).map(
      (x) => ({ seq: x.seq, at: x.at, type: x.type, body: x.body }),
    );
  }

  #evictRun(r: string, b: ActivityBounds): void {
    const state = this.#db.prepare("SELECT activity_rows AS n, activity_bytes AS bytes, last_seq AS last FROM composer_runs WHERE run_id = ?");
    const other = this.#db.prepare("SELECT id FROM composer_activity WHERE run_id = ? AND seq < ? AND type <> 'request' ORDER BY seq LIMIT 1");
    const anyOld = this.#db.prepare("SELECT id FROM composer_activity WHERE run_id = ? AND seq < ? ORDER BY seq LIMIT 1");
    for (;;) {
      const s = state.get(r) as { n: number; bytes: number; last: number };
      if (s.n <= b.maxRunRows && s.bytes <= b.maxRunBytes) return;
      // A `request` event (where a provider request went, PRV-4) outlives the run's other events.
      const victim = (other.get(r, s.last) ?? anyOld.get(r, s.last)) as { id: number } | undefined;
      if (victim === undefined) return;
      this.#delete(victim.id);
    }
  }

  #evictTotal(b: ActivityBounds, kept: number): void {
    const totals = this.#db.prepare("SELECT rows AS n, bytes FROM composer_activity_totals WHERE id = 1");
    const finished = this.#db.prepare(
      "SELECT a.id FROM composer_activity a JOIN agent_runs r ON r.id = a.run_id WHERE r.state NOT IN ('QUEUED','RUNNING') AND a.id <> ? ORDER BY a.id LIMIT 1",
    );
    const notNewest = this.#db.prepare("SELECT a.id FROM composer_activity a JOIN composer_runs c ON c.run_id = a.run_id WHERE a.seq < c.last_seq ORDER BY a.id LIMIT 1");
    for (;;) {
      const t = totals.get() as { n: number; bytes: number };
      if (t.n <= b.maxRows && t.bytes <= b.maxBytes) return;
      const victim = (finished.get(kept) ?? notNewest.get()) as { id: number } | undefined;
      if (victim === undefined) return;
      this.#delete(victim.id);
    }
  }

  #delete(id: number): void {
    one(this.#db.prepare("DELETE FROM composer_activity WHERE id = ?").run(id));
  }
}

function one(result: { changes: number | bigint }): void {
  if (Number(result.changes) !== 1) throw new AxisError("E_NOT_FOUND", "Composer run record not found");
}
