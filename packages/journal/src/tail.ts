// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { DatabaseSync } from "@axis/audit";

/** One committed state change, as the event sources read it: the row id (the cursor), what changed and its new state. */
export interface TransitionTail {
  readonly id: number;
  readonly entity: "workspace" | "run";
  readonly entityId: string;
  readonly to: string;
}

/** Most rows one read returns. */
export const MAX_TAIL_ROWS = 1000;

/**
 * The transition rows after `afterId`, oldest first, at most `limit` (clamped to 1..MAX_TAIL_ROWS). Read only; used by
 * the daemon's event sources (docs/design/events.md section 4). No reason, actor or timestamp is returned.
 */
export function transitionsSince(db: DatabaseSync, afterId: number, limit: number): TransitionTail[] {
  const after = Number.isSafeInteger(afterId) && afterId > 0 ? afterId : 0;
  const n = Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), MAX_TAIL_ROWS) : 1;
  const rows = db
    .prepare("SELECT id, entity, entity_id, to_state FROM state_transitions WHERE id > ? ORDER BY id LIMIT ?")
    .all(after, n) as unknown as Array<{ id: number; entity: "workspace" | "run"; entity_id: string; to_state: string }>;
  return rows.map((r) => ({ id: r.id, entity: r.entity, entityId: r.entity_id, to: r.to_state }));
}

/** The newest transition row id, or 0 when there is none. */
export function lastTransitionId(db: DatabaseSync): number {
  const row = db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM state_transitions").get() as { id: number } | undefined;
  return row?.id ?? 0;
}
