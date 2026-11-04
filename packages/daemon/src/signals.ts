// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { ShutdownResult } from "./shutdown.js";

/** The part of `Daemon` the signal handler drives. */
export interface ShutdownCapable {
  shutdown(reason: string): Promise<ShutdownResult>;
  escalate(): void;
}

/** The part of `process` used: injectable so tests need not send real signals. */
export interface SignalSource {
  on(signal: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void): unknown;
  off(signal: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void): unknown;
}

export interface SignalOptions {
  /** Default SIGTERM and SIGINT. */
  readonly signals?: readonly NodeJS.Signals[];
  /**
   * Called once when shutdown has finished, with 0 for a clean shutdown and 1 when handlers were
   * cancelled or are still running, and the full result: close the journal or audit database only when
   * `result.unsettled === 0` and `result.flushed !== "running"`, because handlers still running and a flush
   * that was cut short may still be writing to it. When shutdown itself failed
   * unexpectedly `result` is undefined. Required: a process with a signal listener no longer dies on the signal.
   */
  readonly exit: (code: number, result: ShutdownResult | undefined) => void;
  readonly source?: SignalSource;
}

export interface SignalHandle {
  /** Remove the listeners. Safe to call more than once. */
  dispose(): void;
}

/**
 * First SIGTERM/SIGINT starts a graceful shutdown; each further one escalates (skips the wait in
 * progress, so the next signal skips the next wait). Listeners are removed when shutdown finishes, so a signal
 * after that gets the default behaviour back. Never throws.
 */
export function installShutdownSignals(daemon: ShutdownCapable, options: SignalOptions): SignalHandle {
  const source: SignalSource = options.source ?? process;
  const signals = [...new Set(options.signals ?? (["SIGTERM", "SIGINT"] as const))];
  let seen = 0;
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    for (const s of signals) source.off(s, listener);
  };
  const listener = (signal: NodeJS.Signals): void => {
    if (++seen > 1) {
      try {
        daemon.escalate();
      } catch {
        // escalation is best effort
      }
      return;
    }
    void daemon
      .shutdown(`signal:${signal}`)
      .then(
        (r) => ({ code: r.graceful && r.unsettled === 0 ? 0 : 1, result: r as ShutdownResult | undefined }),
        () => ({ code: 1, result: undefined as ShutdownResult | undefined }),
      )
      .then(({ code, result }) => {
        dispose();
        try {
          options.exit(code, result);
        } catch {
          // the caller's exit hook must not turn into an unhandled rejection
        }
      });
  };
  for (const s of signals) source.on(s, listener);
  return { dispose };
}
