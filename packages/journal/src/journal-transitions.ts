// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { DatabaseSync } from "@axis/audit";
import type { Transition } from "./model.js";

/** `Journal.transitions`, moved out of `journal.ts` unchanged (ticket PV-X2): transition history, oldest first. */
export function readTransitions(db: DatabaseSync, entity: "workspace" | "run", entityId: string): Transition[] {
  const rows = db
    .prepare(
      "SELECT entity, entity_id, from_state, to_state, reason, actor, ts FROM state_transitions WHERE entity = ? AND entity_id = ? ORDER BY id",
    )
    .all(entity, entityId) as unknown as Array<{
    entity: "workspace" | "run";
    entity_id: string;
    from_state: string | null;
    to_state: string;
    reason: string | null;
    actor: string;
    ts: string;
  }>;
  return rows.map((r) => ({
    entity: r.entity,
    entityId: r.entity_id,
    from: r.from_state,
    to: r.to_state,
    reason: r.reason,
    actor: r.actor,
    ts: r.ts,
  }));
}
