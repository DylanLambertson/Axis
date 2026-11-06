// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { createHash } from "node:crypto";
import type { EventHub } from "@axis/daemon";
import { RUN_STATE_VALUES } from "@axis/protocol";
import type { JournalReader } from "../host.js";

/** Default pump period. The UI polled every 1 to 2 s before E1; a hint now arrives within one period. */
export const EVENT_PUMP_MS = 250;
/** Journal rows read per tick; the rest wait for the next tick. */
export const EVENT_ROWS_PER_TICK = 512;

export interface EventSourcesDeps {
  readonly hub: Pick<EventHub, "publish" | "subscriptionCount" | "windowsFor">;
  readonly journal: Pick<JournalReader, "transitionsSince" | "lastTransitionId">;
  /** The audit chain head sequence (0 for an empty chain). */
  readonly auditHead: () => number;
  readonly anchorStalled: () => boolean;
  /** The open challenges of one window (`ApprovalsPort.pending`, which also drops expired ones). */
  readonly pending: (windowId: string) => ReadonlyArray<{ readonly challengeId: string }>;
  /** Default `EVENT_PUMP_MS`. `0`: no timer (the caller calls `tick`). */
  readonly intervalMs?: number;
  /** A failing source, by fixed reason only: nothing a source read is passed on. */
  readonly onError?: (reason: "events_source") => void;
}

export interface EventSources {
  /** One pass over every source. Never throws. */
  tick(): void;
  /** Stop the timer. Idempotent. */
  dispose(): void;
}

const RUN_STATES: ReadonlySet<string> = new Set(RUN_STATE_VALUES);

/**
 * The host's event emitters (docs/design/events.md section 4). One unreferenced timer reads, per tick: the committed
 * journal transitions after a cursor (workspace and run state, whoever wrote them), the anchor stall flag, the audit
 * head, and the open-challenge set of each window that has an `approvals` subscription. While nobody is subscribed the
 * cursors only move forward, so history is never replayed as events. Every event is an id or a closed value; a hint
 * that turns out spurious costs the client one read, so a doubtful case publishes rather than stays quiet.
 */
export function createEventSources(deps: EventSourcesDeps): EventSources {
  const { hub, journal } = deps;
  const read = <T>(fn: () => T, fallback: T): T => {
    try {
      return fn();
    } catch {
      deps.onError?.("events_source");
      return fallback;
    }
  };
  /** Undefined until the newest row id could be read: a cursor of 0 would replay the whole history as events. */
  let cursor: number | undefined = read<number | undefined>(() => journal.lastTransitionId(), undefined);
  let head = read(() => deps.auditHead(), 0);
  let stalled = read(() => deps.anchorStalled() === true, false);
  /** Per window: a hash of its open challenge ids (never the ids themselves). */
  const seen = new Map<string, string>();
  let timer: ReturnType<typeof setInterval> | undefined;

  const guard = (fn: () => void): void => {
    try {
      fn();
    } catch {
      deps.onError?.("events_source");
    }
  };

  const transitions = (quiet: boolean): void => {
    if (quiet || cursor === undefined) {
      cursor = Math.max(cursor ?? 0, journal.lastTransitionId());
      return;
    }
    for (const row of journal.transitionsSince(cursor, EVENT_ROWS_PER_TICK)) {
      cursor = row.id;
      if (row.entity === "workspace") hub.publish({ topic: "workspaces", workspaceId: row.entityId });
      else if (row.entity === "run") hub.publish(RUN_STATES.has(row.to) ? { topic: "runs", runId: row.entityId, state: row.to } : { topic: "runs", runId: row.entityId });
    }
  };

  const anchor = (quiet: boolean): void => {
    const now = deps.anchorStalled() === true;
    if (now !== stalled && !quiet) hub.publish({ topic: "anchor", stalled: now });
    stalled = now;
  };

  const audit = (quiet: boolean): void => {
    const now = deps.auditHead();
    if (now !== head && !quiet) hub.publish({ topic: "audit", headSeq: now });
    head = now;
  };

  const approvals = (): void => {
    const windows = hub.windowsFor("approvals");
    for (const w of [...seen.keys()]) if (!windows.has(w)) seen.delete(w);
    for (const w of windows) {
      const ids = deps.pending(w).map((c) => c.challengeId).sort();
      const digest = createHash("sha256").update(JSON.stringify(ids)).digest("hex");
      // A window seen for the first time gets a hint too: its subscription may predate a change the next read shows.
      if (seen.get(w) !== digest) hub.publish({ topic: "approvals" }, { windowId: w });
      seen.set(w, digest);
    }
  };

  const tick = (): void => {
    const quiet = hub.subscriptionCount === 0;
    guard(() => transitions(quiet));
    guard(() => anchor(quiet));
    guard(() => audit(quiet));
    guard(approvals);
  };

  const period = deps.intervalMs ?? EVENT_PUMP_MS;
  if (period > 0) {
    timer = setInterval(tick, period);
    (timer as { unref?: () => void }).unref?.();
  }
  return {
    tick,
    dispose() {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
  };
}
