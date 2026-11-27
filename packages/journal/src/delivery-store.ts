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
  /** The keyset cursor of the next page (`pending(principal, limit, after)`): this row's place in send order. */
  readonly cursor: number;
}

type Row = Record<string, unknown>;

export class DeliveryRecords {
  readonly #db: DatabaseSync;
  readonly #ts: () => string;

  constructor(db: DatabaseSync, ts: () => string) {
    this.#db = db;
    this.#ts = ts;
  }

  /**
   * Messages addressed to `principal` that have no delivery row (not leased, acknowledged or quarantined), in send order,
   * after the keyset `cursor` (0 for the first page), at most `limit`. A caller pages past rows it cannot deliver now.
   */
  pending(principal: string, limit: number, cursor = 0): PendingDelivery[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new AxisError("E_INVALID_ARGUMENT", "A list limit is out of range", { reason: "limit" });
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new AxisError("E_INVALID_ARGUMENT", "A cursor is out of range", { reason: "cursor" });
    const rows = this.#db
      .prepare(
        "SELECT r.message_id, r.thread_id, r.seq, m.rowid AS cursor FROM message_recipients r JOIN agent_messages m ON m.id = r.message_id WHERE r.principal = ? AND m.rowid > ? AND NOT EXISTS (SELECT 1 FROM message_deliveries d WHERE d.message_id = r.message_id AND d.principal = r.principal) ORDER BY m.rowid LIMIT ?",
      )
      .all(principal, cursor, limit) as Row[];
    return rows.map((r) => ({ messageId: String(r["message_id"]), threadId: String(r["thread_id"]), seq: Number(r["seq"]), cursor: Number(r["cursor"]) }));
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

  /** Release a run's leases of these messages (its request failed or it ended first); acked rows stay. Returns how many. */
  release(runId: string, messageIds: readonly string[]): number {
    const stmt = this.#db.prepare("DELETE FROM message_deliveries WHERE run_id = ? AND message_id = ? AND state = 'leased'");
    let n = 0;
    for (const id of messageIds) n += Number(stmt.run(runId, id).changes);
    return n;
  }

  /** Release every lease (host start: no run survives a restart). Acknowledged deliveries stay. Returns how many. */
  releaseLeases(): number {
    return Number(this.#db.prepare("DELETE FROM message_deliveries WHERE state = 'leased'").run().changes);
  }

  /** Count one failed delivery of a message to a recipient; returns the count so far. */
  noteFailure(messageId: string, principal: string): number {
    this.#db
      .prepare("INSERT INTO message_delivery_failures (message_id, principal, failures) VALUES (?, ?, 1) ON CONFLICT (message_id, principal) DO UPDATE SET failures = failures + 1")
      .run(messageId, principal);
    return Number((this.#db.prepare("SELECT failures FROM message_delivery_failures WHERE message_id = ? AND principal = ?").get(messageId, principal) as Row)["failures"]);
  }

  /** Quarantine a message for a recipient: a `failed` row, never offered again. False when it already has a delivery row. */
  quarantine(messageId: string, principal: string, runId: string): boolean {
    const r = this.#db
      .prepare("INSERT INTO message_deliveries (message_id, principal, run_id, state, leased_at) VALUES (?, ?, ?, 'failed', ?) ON CONFLICT (message_id, principal) DO NOTHING")
      .run(messageId, principal, runId, this.#ts());
    return Number(r.changes) === 1;
  }

  /** The delivery of a message to a recipient, or undefined. */
  get(messageId: string, principal: string): { readonly runId: string; readonly state: "leased" | "acked" | "failed" } | undefined {
    const r = this.#db.prepare("SELECT run_id, state FROM message_deliveries WHERE message_id = ? AND principal = ?").get(messageId, principal) as Row | undefined;
    return r === undefined ? undefined : { runId: String(r["run_id"]), state: String(r["state"]) as "leased" | "acked" | "failed" };
  }
}
