// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// OS-3h (docs/design/own-shell-main-seam.md §3a): the ACKNOWLEDGED control hand-over between the pty process and the daemon,
// which replaces `ControlHandover` in the own shell (the legacy Code OSS shell keeps that one). Posting a port is not a completed
// hand-over:
//
// - Whenever both children are up after either (re)started, main makes ONE channel, numbers it (generation G, rising for main's
//   lifetime) and posts `{ type: "pty-control", generation: G }` with port A to the pty process and port B to the daemon.
// - Each child adopts G (latest wins) and answers `pty-control-adopted` with G. Once BOTH did, main sends both
//   `pty-control-confirmed` with G: the hand-over is done. An answer for any generation other than the one in flight is ignored.
// - Without both answers within `ackMs`, main retires G AT THE RECEIVERS (it holds no live endpoint once a port is transferred):
//   `pty-control-close` with G to each child, which answers `pty-control-closed`. A child that does not answer within `closeMs`
//   is torn down (`teardown`, SIGKILL by exact pid in the seam), which ends every endpoint it held. Then main posts G+1.
// - After `maxGenerations` failed generations per (re)start: `handover_failed`, and `onFailed` (the seam tears the pty process
//   down and holds it until the next daemon start). Every case ends in a working channel or this defined failed state.
// - A post that throws closes that side's port and the unposted one, and counts as a failed generation.
// - A child's exit cancels everything pending for it; the next (re)start begins a new round.
// Electron-free: the seam passes `createChannel`, `closePort`, the timers and the teardown.

export type HandoverSide = "pty" | "daemon";

export interface AckedHandoverChild {
  postMessage(message: unknown, transfer?: readonly unknown[]): void;
}

export type AckedHandoverEvent = "posted" | "handed_over" | "retired" | "teardown" | "post_failed" | "handover_failed";

export interface AckedHandoverOptions<P> {
  readonly createChannel: () => { readonly port1: P; readonly port2: P };
  readonly closePort: (port: P) => void;
  readonly timers: { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };
  /** Ends a child that did not answer a close (SIGKILL by its exact pid). */
  readonly teardown: (side: HandoverSide) => void;
  /** Every generation of this round failed. */
  readonly onFailed: () => void;
  readonly onEvent?: (event: AckedHandoverEvent, fields: { readonly generation?: number; readonly side?: HandoverSide; readonly attempt?: number }) => void;
  /**
   * Whether a side's acknowledgement window is open (OS-3h review S2): a child still loading cannot answer yet. The seam opens it
   * at the child's first message, or after a start grace. While it is closed an unanswered generation waits (not counted as a
   * failure) and an unanswered close never tears the child down: the child's own start bound (the daemon's ready timeout) applies.
   * Default: always open.
   */
  readonly windowOpen?: (side: HandoverSide) => boolean;
  readonly ackMs?: number;
  readonly closeMs?: number;
  readonly maxGenerations?: number;
}

export const DEFAULT_HANDOVER_ACK_MS = 5_000;
export const DEFAULT_HANDOVER_CLOSE_MS = 2_000;
export const DEFAULT_HANDOVER_GENERATIONS = 3;

interface InFlight {
  readonly generation: number;
  readonly acks: Set<HandoverSide>;
  timer: unknown;
}

export class AckedHandover<P> {
  readonly #o: AckedHandoverOptions<P>;
  readonly #children = new Map<HandoverSide, AckedHandoverChild>();
  readonly #closing = new Map<HandoverSide, { generation: number; timer: unknown }>();
  #next = 1;
  #attempts = 0;
  #inFlight: InFlight | undefined;
  #disposed = false;

  constructor(options: AckedHandoverOptions<P>) {
    this.#o = options;
  }

  /** The pty process's child, alive or gone. */
  pty(child: AckedHandoverChild, alive: boolean): void {
    this.#child("pty", child, alive);
  }

  /** The daemon's child, alive or gone. */
  daemon(child: AckedHandoverChild, alive: boolean): void {
    this.#child("daemon", child, alive);
  }

  /** A child's `pty-control-adopted`. `from` is the child instance it came from: an answer from any other instance is ignored. */
  adopted(side: HandoverSide, generation: number, from?: AckedHandoverChild): void {
    const f = this.#inFlight;
    if (this.#disposed || f === undefined || f.generation !== generation) return;
    if (from !== undefined && this.#children.get(side) !== from) return;
    f.acks.add(side);
    if (f.acks.size < 2) return;
    this.#o.timers.clear(f.timer);
    this.#inFlight = undefined;
    for (const [, c] of this.#children) this.#post(c, { type: "pty-control-confirmed", generation });
    this.#emit("handed_over", { generation });
  }

  /** A child's `pty-control-closed`, from the instance `from` (any other instance is ignored). */
  closed(side: HandoverSide, generation: number, from?: AckedHandoverChild): void {
    if (from !== undefined && this.#children.get(side) !== from) return;
    const c = this.#closing.get(side);
    if (c === undefined || c.generation !== generation) return;
    this.#o.timers.clear(c.timer);
    this.#closing.delete(side);
  }

  /** The generation in flight, if any (for tests and the log). */
  inFlight(): number | undefined {
    return this.#inFlight?.generation;
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#inFlight !== undefined) this.#o.timers.clear(this.#inFlight.timer);
    this.#inFlight = undefined;
    for (const [, c] of this.#closing) this.#o.timers.clear(c.timer);
    this.#closing.clear();
    this.#children.clear();
  }

  #child(side: HandoverSide, child: AckedHandoverChild, alive: boolean): void {
    if (this.#disposed) return;
    if (!alive) {
      if (this.#children.get(side) !== child) return;
      this.#children.delete(side);
      const c = this.#closing.get(side);
      if (c !== undefined) this.#o.timers.clear(c.timer);
      this.#closing.delete(side);
      // The round is over: its other end is retired at the survivor, and a new round starts when this side is back.
      const f = this.#inFlight;
      if (f !== undefined) {
        this.#o.timers.clear(f.timer);
        this.#inFlight = undefined;
        this.#retire(f.generation);
      }
      return;
    }
    this.#children.set(side, child);
    if (this.#children.size === 2) {
      // A (re)start: a new round of at most maxGenerations. A round still in flight is retired first.
      const f = this.#inFlight;
      if (f !== undefined) {
        this.#o.timers.clear(f.timer);
        this.#inFlight = undefined;
        this.#retire(f.generation);
      }
      this.#attempts = 0;
      this.#round();
    }
  }

  #round(): void {
    const pty = this.#children.get("pty");
    const daemon = this.#children.get("daemon");
    if (pty === undefined || daemon === undefined || this.#disposed) return;
    this.#attempts++;
    const generation = this.#next++;
    const { port1, port2 } = this.#o.createChannel();
    const message = { type: "pty-control", generation };
    let ptyPosted = false;
    try {
      pty.postMessage({ ...message }, [port1]);
      ptyPosted = true;
      daemon.postMessage({ ...message }, [port2]);
    } catch {
      // The unposted port(s) are still main's: close them. A port the pty process already holds is retired there.
      if (!ptyPosted) this.#o.closePort(port1);
      this.#o.closePort(port2);
      this.#emit("post_failed", { generation, side: ptyPosted ? "daemon" : "pty" });
      if (ptyPosted) this.#retire(generation);
      return this.#failedGeneration(generation);
    }
    this.#emit("posted", { generation, attempt: this.#attempts });
    const f: InFlight = { generation, acks: new Set(), timer: undefined };
    const arm = (): void => {
      f.timer = this.#o.timers.set(() => {
        if (this.#inFlight !== f) return;
        // A side that has not answered and is still starting: wait another window, uncounted.
        const waiting = (["pty", "daemon"] as const).filter((side) => !f.acks.has(side));
        if (waiting.some((side) => !this.#open(side))) return arm();
        this.#inFlight = undefined;
        this.#retire(generation);
        this.#failedGeneration(generation);
      }, this.#o.ackMs ?? DEFAULT_HANDOVER_ACK_MS);
    };
    arm();
    this.#inFlight = f;
  }

  #failedGeneration(generation: number): void {
    if (this.#attempts < (this.#o.maxGenerations ?? DEFAULT_HANDOVER_GENERATIONS)) return this.#round();
    this.#emit("handover_failed", { generation, attempt: this.#attempts });
    try {
      this.#o.onFailed();
    } catch {
      // the seam's teardown never changes the hand-over
    }
  }

  /** Retires `generation` at each live child: a close instruction, and a teardown if it is not answered in time. */
  #retire(generation: number): void {
    this.#emit("retired", { generation });
    for (const [side, child] of this.#children) {
      // A newer retire replaces an older one's teardown timer for this side: the child is then waited on for the newer close only,
      // which also covers the older generation (a child holds one generation at a time).
      const prev = this.#closing.get(side);
      if (prev !== undefined) this.#o.timers.clear(prev.timer);
      const arm = (): unknown =>
        this.#o.timers.set(() => {
          const c = this.#closing.get(side);
          if (c?.generation !== generation) return;
          // A child still starting is never torn down here: its own start bound applies.
          if (!this.#open(side)) {
            c.timer = arm();
            return;
          }
          this.#closing.delete(side);
          this.#emit("teardown", { generation, side });
          try {
            this.#o.teardown(side);
          } catch {
            // already gone
          }
        }, this.#o.closeMs ?? DEFAULT_HANDOVER_CLOSE_MS);
      this.#closing.set(side, { generation, timer: arm() });
      this.#post(child, { type: "pty-control-close", generation });
    }
  }

  #open(side: HandoverSide): boolean {
    try {
      return this.#o.windowOpen?.(side) ?? true;
    } catch {
      return true;
    }
  }

  #post(child: AckedHandoverChild, message: unknown): void {
    try {
      child.postMessage(message);
    } catch {
      // a child that cannot take a message is about to exit; its exit ends the round
    }
  }

  #emit(event: AckedHandoverEvent, fields: { generation?: number; side?: HandoverSide; attempt?: number }): void {
    try {
      this.#o.onEvent?.(event, fields);
    } catch {
      // an observer never changes the hand-over
    }
  }
}
