// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { withTransaction, type DatabaseSync } from "@axis/audit";
import { PLUGIN_ISSUE_LIMITS } from "./schema-plugin-issues.js";

/**
 * The plugin challenge counter (schema version 17, PV-K1e-a2): `record` is the daemon's one call, made when a plugin's request
 * would raise an approval challenge and before the challenge exists. In one transaction it counts the plugin's issues in the
 * last hour and, under the limit, records this one and prunes the rows more than a day older than it. Nothing calls it in
 * production until PV-K1e-b wires the challenge gate's plugin branch.
 */

export type PluginIssueRefusal = "hourly_limit" | "issue_cap" | "unknown_plugin";
export type PluginIssueResult = { readonly ok: true } | { readonly ok: false; readonly reason: PluginIssueRefusal };

type Row = Record<string, unknown>;

export class PluginIssueRecords {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  /** Issues of the plugin in the project within the hour ending at `now` (clamped to the newest row). */
  inLastHour(pluginId: string, projectId: string, now: number): number {
    return this.#count(pluginId, projectId, this.#clamp(now));
  }

  /** Count and record one issue at `now` (epoch milliseconds), or refuse with a closed reason and record nothing. */
  record(pluginId: string, projectId: string, now: number): PluginIssueResult {
    if (!Number.isSafeInteger(now) || now < 0) throw new RangeError("issue time is out of range");
    return withTransaction(this.#db, (): PluginIssueResult => {
      if (this.#db.prepare("SELECT 1 FROM plugin_enablement WHERE plugin_id = ? AND project_id = ?").get(pluginId, projectId) === undefined) return { ok: false, reason: "unknown_plugin" };
      // The newest row is the clock: a system clock that stepped back is taken forward to it, so no hour starts over.
      const at = this.#clamp(now);
      if (this.#count(pluginId, projectId, at) >= PLUGIN_ISSUE_LIMITS.perHour) return { ok: false, reason: "hourly_limit" };
      if (Number((this.#db.prepare("SELECT count(*) AS n FROM plugin_challenge_issues").get() as Row)["n"]) >= PLUGIN_ISSUE_LIMITS.rows) return { ok: false, reason: "issue_cap" };
      this.#db.prepare("INSERT INTO plugin_challenge_issues (plugin_id, project_id, issued_at) VALUES (?, ?, ?)").run(pluginId, projectId, at);
      // After the insert, this row is the newest: the prune's bound is the table rule's own (a day before the newest row).
      this.#db.prepare("DELETE FROM plugin_challenge_issues WHERE issued_at < ?").run(at - PLUGIN_ISSUE_LIMITS.keepMs);
      return { ok: true };
    });
  }

  #clamp(now: number): number {
    const newest = (this.#db.prepare("SELECT max(issued_at) AS m FROM plugin_challenge_issues").get() as Row)["m"];
    return typeof newest === "number" && newest > now ? newest : now;
  }

  #count(pluginId: string, projectId: string, at: number): number {
    return Number((this.#db.prepare("SELECT count(*) AS n FROM plugin_challenge_issues WHERE plugin_id = ? AND project_id = ? AND issued_at > ?").get(pluginId, projectId, at - PLUGIN_ISSUE_LIMITS.windowMs) as Row)["n"]);
  }
}
