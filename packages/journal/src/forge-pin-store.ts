// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { AxisError, withTransaction, type DatabaseSync } from "@axis/audit";

/**
 * The confirmed forge repository of each project (schema version 13, ticket PV-D2 slice 2b). A data layer: the daemon's forge
 * service decides what may be pinned (only the value it just displayed, on the user's own `pinRepository`) and re-vets every
 * value it reads. `set` inserts the first pin and updates it in place afterwards; there is no upsert (the table refuses one).
 */
export interface ForgePin {
  readonly host: string;
  readonly owner: string;
  readonly repo: string;
}

type Row = Record<string, unknown>;

export class ForgePinRecords {
  readonly #db: DatabaseSync;
  readonly #ts: () => string;

  constructor(db: DatabaseSync, ts: () => string) {
    this.#db = db;
    this.#ts = ts;
  }

  /** The pin of `projectId` as stored (host, owner, repository only), or undefined. */
  get(projectId: string): ForgePin | undefined {
    const r = this.#db.prepare("SELECT host, owner, repo FROM forge_pins WHERE project_id = ?").get(projectId) as Row | undefined;
    if (r === undefined) return undefined;
    const { host, owner, repo } = r;
    return typeof host === "string" && typeof owner === "string" && typeof repo === "string" ? { host, owner, repo } : undefined;
  }

  /** The user confirmed `pin` for `projectId`: the first pin is inserted, a later one replaces the values in place. */
  set(projectId: string, pin: ForgePin): void {
    if (typeof projectId !== "string" || [pin.host, pin.owner, pin.repo].some((v) => typeof v !== "string")) {
      throw new AxisError("E_INVALID_ARGUMENT", "A pin needs a project and a repository", { reason: "pin" });
    }
    const at = this.#ts();
    withTransaction(this.#db, () => {
      const updated = this.#db.prepare("UPDATE forge_pins SET host = ?, owner = ?, repo = ?, confirmed_by = 'user', confirmed_at = ? WHERE project_id = ?").run(pin.host, pin.owner, pin.repo, at, projectId);
      if (Number(updated.changes) === 0) {
        this.#db.prepare("INSERT INTO forge_pins (project_id, host, owner, repo, confirmed_by, confirmed_at) VALUES (?, ?, ?, ?, 'user', ?)").run(projectId, pin.host, pin.owner, pin.repo, at);
      }
    });
  }
}
