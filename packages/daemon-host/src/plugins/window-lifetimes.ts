// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

import type { Identity, SessionLifecycle } from "@axis/daemon";

/**
 * The lifetimes of the code windows that host plugin views (PV-K2 K2-g4a, `docs/design/plugin-grant-contract.md` section 8.4).
 * A window id (`w<n>`) stays the same across a reload, so it cannot tell two lifetimes apart; this keeps, per window id, an
 * unguessable epoch and the desktop connections attached within it:
 * - the first accepted desktop connection of a closed window starts a new epoch (16 random bytes, base64url, never handed out
 *   twice);
 * - more connections only join it, and closing one of several leaves it alive;
 * - the last close ends it for good, and so does `gone` (main's `window.gone`), whatever is still attached;
 * - a connection is counted once, however often its accept or close is reported, and a close for a connection the epoch does
 *   not hold (never accepted, or attached to an ended epoch) changes nothing.
 * Only `desktop` sessions count. Ended epochs are kept in a bounded ring, so a recent one is answered `ended`; one that fell out of
 * the ring is `unknown`. Neither is ever `alive`.
 */
export type EpochStatus = "alive" | "ended" | "unknown";

export interface WindowLifetimes extends SessionLifecycle {
  /** Main's `window.gone`: ends the window's epoch, whatever is still attached. Unknown or closed windows: nothing. */
  gone(windowId: string): void;
  /** The window's live epoch, `undefined` when it has none. */
  current(windowId: string): string | undefined;
  status(windowId: string, epoch: string): EpochStatus;
  alive(windowId: string, epoch: string): boolean;
}

export interface WindowLifetimesOptions {
  /** `n` bytes from a CSPRNG. */
  readonly randomBytes: (n: number) => Uint8Array;
  /** Ended epochs remembered. Default 1024. */
  readonly endedRing?: number;
}

const EPOCH_BYTES = 16;
const MAX_DRAWS = 4;

interface Live {
  readonly epoch: string;
  readonly connections: Set<string>;
}

export function createWindowLifetimes(options: WindowLifetimesOptions): WindowLifetimes {
  const ringSize = options.endedRing ?? 1024;
  if (!Number.isSafeInteger(ringSize) || ringSize < 1) throw new Error("window lifetimes: endedRing must be a positive integer");
  const live = new Map<string, Live>();
  /** `windowId` NUL `epoch`, oldest first. */
  const ended = new Set<string>();
  const key = (windowId: string, epoch: string): string => `${windowId}\u0000${epoch}`;
  const isEpochTaken = (epoch: string): boolean => {
    for (const l of live.values()) if (l.epoch === epoch) return true;
    for (const k of ended) if (k.endsWith(`\u0000${epoch}`)) return true;
    return false;
  };
  const draw = (): string => {
    for (let i = 0; i < MAX_DRAWS; i++) {
      const bytes = options.randomBytes(EPOCH_BYTES);
      if (bytes.length !== EPOCH_BYTES) break;
      const epoch = Buffer.from(bytes).toString("base64url");
      if (!isEpochTaken(epoch)) return epoch;
    }
    throw new Error("window epoch: no fresh random value");
  };
  const end = (windowId: string): void => {
    const l = live.get(windowId);
    if (l === undefined) return;
    live.delete(windowId);
    ended.add(key(windowId, l.epoch));
    while (ended.size > ringSize) ended.delete(ended.values().next().value as string);
  };
  return {
    accepted(identity: Identity): void {
      if (identity.clientKind !== "desktop") return;
      let l = live.get(identity.windowId);
      if (l === undefined) {
        l = { epoch: draw(), connections: new Set() };
        live.set(identity.windowId, l);
      }
      l.connections.add(identity.connectionId);
    },
    closed(identity: Identity): void {
      if (identity.clientKind !== "desktop") return;
      const l = live.get(identity.windowId);
      if (l === undefined || !l.connections.delete(identity.connectionId)) return;
      if (l.connections.size === 0) end(identity.windowId);
    },
    gone(windowId: string): void {
      end(windowId);
    },
    current(windowId: string): string | undefined {
      return live.get(windowId)?.epoch;
    },
    status(windowId: string, epoch: string): EpochStatus {
      if (live.get(windowId)?.epoch === epoch) return "alive";
      return ended.has(key(windowId, epoch)) ? "ended" : "unknown";
    },
    alive(windowId: string, epoch: string): boolean {
      return live.get(windowId)?.epoch === epoch;
    },
  };
}
