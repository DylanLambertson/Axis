// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { Tombstones } from "./tombstones.js";
import { OPEN, type Record_ } from "./types.js";

export interface QuotaLimits {
  /** Per requester in one window. Another window of the same user is not affected by this one's flood. */
  readonly perActorWindow: number;
  /** Per requester across all windows: the backstop, larger than `perActorWindow`. */
  readonly perActor: number;
  readonly perWindow: number;
  readonly total: number;
}

/**
 * True when one more challenge for this requester in this window would exceed
 * a quota. Open records and tombstones (withdrawn challenges that have not yet
 * reached their original expiry) both count. One pass over the records.
 */
export function overQuota(records: Iterable<Record_>, tombs: Tombstones, actor: string, windowId: string, limits: QuotaLimits): boolean {
  const t = tombs.count(actor, windowId);
  let total = t.total;
  let perActor = t.actor;
  let perWindow = t.window;
  let perActorWindow = t.actorWindow;
  for (const r of records) {
    if (!OPEN.has(r.state)) continue;
    total++;
    const a = r.requester === actor;
    const w = r.windowId === windowId;
    if (a) perActor++;
    if (w) perWindow++;
    if (a && w) perActorWindow++;
  }
  return perActorWindow >= limits.perActorWindow || perActor >= limits.perActor || perWindow >= limits.perWindow || total >= limits.total;
}
