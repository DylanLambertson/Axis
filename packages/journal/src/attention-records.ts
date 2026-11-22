// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { AxisError, type DatabaseSync } from "@axis/audit";

/**
 * The journal's reads behind the project home's needs-attention summary (ticket PV-D4, `axis.attention/1`). Read only: ids,
 * kinds, states and counts, never a path, a branch, a reason, a message body or a sender. Every query takes a row limit,
 * so a reply is bounded whatever the tables hold; the daemon decides what the rows mean (and which live state to ask).
 *
 * A live workspace is one in `READY`, the only state a run is created in: a workspace being created, finalised, removed or
 * failed never needs attention.
 */
export interface AttentionRun {
  readonly runId: string;
  readonly workspaceId: string;
  readonly kind: "composer" | "cli";
  readonly state: string;
  /** The agent the run was started for (schema v12), or null. */
  readonly agentId: string | null;
}

/** The largest limit a caller may ask for. */
export const MAX_ATTENTION_ROWS = 10_000;

const LIVE_WORKSPACE = "w.project_id = ? AND w.state = 'READY'";
const RUN_COLUMNS = "r.id AS run_id, r.workspace_id, r.kind, r.state, r.agent_id";

type Row = Record<string, unknown>;

function limitOf(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ATTENTION_ROWS) {
    throw new AxisError("E_INVALID_ARGUMENT", "An attention read needs a limit from 1 to 10000", { reason: "limit" });
  }
  return limit;
}

function toRun(r: Row): AttentionRun {
  const kind = r["kind"];
  const agentId = r["agent_id"];
  return {
    runId: String(r["run_id"]),
    workspaceId: String(r["workspace_id"]),
    kind: kind === "cli" ? "cli" : "composer",
    state: String(r["state"]),
    agentId: typeof agentId === "string" ? agentId : null,
  };
}

export class AttentionRecords {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  /** The newest run of each live workspace of the project (at most `limit`, by workspace id). A workspace with no run has none. */
  latestRuns(projectId: string, limit: number): AttentionRun[] {
    const sql = `SELECT ${RUN_COLUMNS} FROM agent_workspaces w JOIN agent_runs r ON r.id = (SELECT r2.id FROM agent_runs r2
      WHERE r2.workspace_id = w.id ORDER BY r2.created_at DESC, r2.rowid DESC LIMIT 1) WHERE ${LIVE_WORKSPACE} ORDER BY w.id LIMIT ?`;
    return (this.#db.prepare(sql).all(projectId, limitOf(limit)) as Row[]).map(toRun);
  }

  /** The project's `RUNNING` runs in its live workspaces, oldest first, at most `limit`. */
  runningRuns(projectId: string, limit: number): AttentionRun[] {
    const sql = `SELECT ${RUN_COLUMNS} FROM agent_runs r JOIN agent_workspaces w ON w.id = r.workspace_id
      WHERE ${LIVE_WORKSPACE} AND r.state = 'RUNNING' ORDER BY r.rowid LIMIT ?`;
    return (this.#db.prepare(sql).all(projectId, limitOf(limit)) as Row[]).map(toRun);
  }

  /**
   * Messages to the user in the project's threads past the user's read cursor, counted up to `limit` (the same rule as
   * `MessageRecords.unread`, over every thread of the project). Nothing of a message is read but its recipient row.
   */
  unreadForUser(projectId: string, limit: number): number {
    const sql = `SELECT count(*) AS n FROM (SELECT 1 FROM message_recipients r JOIN message_threads t ON t.id = r.thread_id
      WHERE r.principal = 'user' AND t.project_id = ? AND r.seq > coalesce((SELECT read_through FROM message_cursors c
      WHERE c.thread_id = r.thread_id AND c.principal = r.principal), 0) LIMIT ?)`;
    const row = this.#db.prepare(sql).get(projectId, limitOf(limit)) as Row | undefined;
    return Number(row?.["n"] ?? 0);
  }
}
