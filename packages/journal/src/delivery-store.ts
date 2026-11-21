// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { AxisError, type DatabaseSync } from "@axis/audit";

/**
 * Delivery state of `axis.messages/1` (schema version 10, ticket PV-M3 slice 2). A data layer: which messages wait for a
 * recipient, which a run leased at a turn boundary, which it acknowledged. The daemon host's delivery pipeline decides
 * what may be delivered (policy, Pause, taint) and calls these inside its own transaction. Every list is bounded.
 */

export interface PendingDelivery {
  readonly messageId: string;
  readonly threadId: string;
  readonly seq: number;
}

type Row = Record<string, unknown>;

export class DeliveryRecords {
  readonly #db: DatabaseSync;
  readonly #ts: () => string;

  constructor(db: DatabaseSync, ts: () => string) {
    this.#db = db;
    this.#ts = ts;
  }

  /** Messages addressed to `principal` that no run has leased or acknowledged, oldest first, at most `limit`. */
  pending(principal: string, limit: number): PendingDelivery[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new AxisError("E_INVALID_ARGUMENT", "A list limit is out of range", { reason: "limit" });
    const rows = this.#db
      .prepare(
        "SELECT r.message_id, r.thread_id, r.seq FROM message_recipients r JOIN agent_messages m ON m.id = r.message_id WHERE r.principal = ? AND NOT EXISTS (SELECT 1 FROM message_deliveries d WHERE d.message_id = r.message_id AND d.principal = r.principal) ORDER BY m.rowid LIMIT ?",
      )
      .all(principal, limit) as Row[];
    return rows.map((r) => ({ messageId: String(r["message_id"]), threadId: String(r["thread_id"]), seq: Number(r["seq"]) }));
  }

  /** Lease one message to a run for its recipient; false when it is already leased or acknowledged (to any run). */
  lease(messageId: string, principal: string, runId: string): boolean {
    const r = this.#db
      .prepare("INSERT INTO message_deliveries (message_id, principal, run_id, state, leased_at) VALUES (?, ?, ?, 'leased', ?) ON CONFLICT (message_id, principal) DO NOTHING")
      .run(messageId, principal, runId, this.#ts());
    return Number(r.changes) === 1;
  }

  /** Acknowledge a run's leases of these messages; returns how many moved to `acked` (a second ack moves none). */
  ack(runId: string, messageIds: readonly string[]): number {
    const stmt = this.#db.prepare("UPDATE message_deliveries SET state = 'acked', acked_at = ? WHERE run_id = ? AND message_id = ? AND state = 'leased'");
    const ts = this.#ts();
    let n = 0;
    for (const id of messageIds) n += Number(stmt.run(ts, runId, id).changes);
    return n;
  }

  /** Release every lease (host start: no run survives a restart). Acknowledged deliveries stay. Returns how many. */
  releaseLeases(): number {
    return Number(this.#db.prepare("DELETE FROM message_deliveries WHERE state = 'leased'").run().changes);
  }

  /** The delivery of a message to a recipient, or undefined. */
  get(messageId: string, principal: string): { readonly runId: string; readonly state: "leased" | "acked" } | undefined {
    const r = this.#db.prepare("SELECT run_id, state FROM message_deliveries WHERE message_id = ? AND principal = ?").get(messageId, principal) as Row | undefined;
    return r === undefined ? undefined : { runId: String(r["run_id"]), state: String(r["state"]) as "leased" | "acked" };
  }
}
