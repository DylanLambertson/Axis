// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

/** Characters of output sent to a viewer and not yet acknowledged. Above `high` the child is paused; above `hard` output is dropped. */
export const FLOW_HIGH = 1024 * 1024;
export const FLOW_LOW = 256 * 1024;
export const FLOW_HARD = 4 * 1024 * 1024;

export interface FlowLimits {
  readonly high: number;
  readonly low: number;
  readonly hard: number;
}

export const DEFAULT_FLOW: FlowLimits = { high: FLOW_HIGH, low: FLOW_LOW, hard: FLOW_HARD };

/**
 * Credit-based flow control for one terminal's output hop (child to viewer). A MessagePort gives no completion signal, so the viewer
 * acknowledges what it has consumed. Memory in flight is bounded by `hard` plus one read of the child: past `high` the child is
 * paused (it then blocks on the kernel's pty buffer); a child that cannot be paused, or output that was already in flight, is
 * dropped past `hard` and counted, and the viewer is told once how much was lost.
 */
export class OutputFlow {
  private unacked = 0;
  private dropped = 0;
  private paused = false;
  constructor(private readonly limits: FlowLimits = DEFAULT_FLOW) {}

  /** A chunk of `n` characters is ready. `send` false: drop it. `pause` true: the caller must pause the child. */
  offer(n: number): { readonly send: boolean; readonly pause: boolean } {
    if (this.unacked + n > this.limits.hard) {
      this.dropped += n;
      return { send: false, pause: this.pauseNow() };
    }
    this.unacked += n;
    return { send: true, pause: this.unacked > this.limits.high && this.pauseNow() };
  }

  /** The viewer consumed `n` characters (clamped to what is outstanding). `resume`: restart the child. `overflow`: characters lost since the last report. */
  ack(n: number): { readonly resume: boolean; readonly overflow: number } {
    this.unacked = Math.max(0, this.unacked - n);
    if (this.unacked > this.limits.low) return { resume: false, overflow: 0 };
    const overflow = this.dropped;
    this.dropped = 0;
    const resume = this.paused;
    this.paused = false;
    return { resume, overflow };
  }

  /** A new viewer (or none): nothing is outstanding any more. Returns whether the child must be resumed. */
  reset(): boolean {
    const resume = this.paused;
    this.unacked = 0;
    this.dropped = 0;
    this.paused = false;
    return resume;
  }

  private pauseNow(): boolean {
    if (this.paused) return false;
    this.paused = true;
    return true;
  }
}
