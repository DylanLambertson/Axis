// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { AxisError } from "@axis/audit";
import type { ShutdownCapable, ShutdownResult } from "@axis/daemon";
import type { ControlClient } from "./control/client.js";
import type { DisposeResult, ListenerTarget } from "./disposables.js";
import { EXIT, type ExitCode } from "./exit-codes.js";
import type { Logger } from "./log/logger.js";

/**
 * Ticket H7: signals, the Windows `shutdown` message and crash handlers (design section 8). One entry point,
 * `installHostLifecycle`, owns step 11 of startup. It never reads `process` itself: the `process`-like target and
 * the exit hook come in, so a test sends no real signal and exits nothing.
 *
 * What it guarantees:
 * - The first trigger (a signal or the control message `shutdown`) runs `daemon.shutdown`; every further trigger,
 *   from either source, escalates the wait in progress.
 * - The database handle and the instance lock are closed (`stop`) ONLY when no handler is still running and the
 *   idempotency flush is not still writing. Otherwise both stay open and the exit hook is told to force the exit.
 * - A crash (`uncaughtException`, `unhandledRejection`) fails closed: one log record of the closed error summary
 *   (never the message, stack or any property of the thrown value), exit code 70, no graceful path and no write.
 * - Every listener and timer it created is removed before the exit hook runs, so a clean exit needs no
 *   `process.exit`: the process drains.
 */

export interface ExitInfo {
  /** What `daemon.shutdown` reported. `undefined` after a crash or when shutdown itself failed. */
  readonly result: ShutdownResult | undefined;
  /**
   * True when `stop` ran: every timer, listener, the database handle and the lock are released, so the process
   * may simply end by draining. False: something may still run or hold the store (or the process crashed), so
   * the caller must end the process itself (`process.exit(code)`).
   */
  readonly released: boolean;
}

export interface LifecycleOptions {
  readonly daemon: ShutdownCapable;
  /** The control client; only `onShutdown` is used. */
  readonly control: Pick<ControlClient, "onShutdown">;
  /** `DaemonHost.stop`: disposes timers, listeners, the database handle, then the lock. */
  readonly stop: () => Promise<DisposeResult>;
  /** The final `checkpoint` and `anchor.put` (design section 8, step 4). Runs only once nothing can still write. */
  readonly finalize?: () => void | Promise<void>;
  /** Bound of `finalize` (default 2000). */
  readonly finalizeTimeoutMs?: number;
  readonly logger?: Logger;
  /** Called exactly once with the exit code. Required: a process with these listeners no longer dies on its own. */
  readonly exit: (code: ExitCode, info: ExitInfo) => void;
  /** Where signals and crash events are listened for: the composition root passes the real `process` (this package never names it). */
  readonly process: ListenerTarget;
  /** Default SIGTERM and SIGINT. */
  readonly signals?: readonly NodeJS.Signals[];
}

export interface LifecycleHandle {
  /** Remove every listener now (idempotent). Does not start a shutdown. */
  dispose(): void;
  /** Resolves after the exit hook was called. Never rejects. */
  readonly finished: Promise<void>;
}

const DEFAULT_FINALIZE_MS = 2_000;
const MAX_FINALIZE_MS = 600_000;

/** The exit code for a finished shutdown: 0 only when everything settled, nothing was cancelled and the flush is done or not needed. */
export function exitCodeForShutdown(result: ShutdownResult | undefined): ExitCode {
  if (result === undefined) return EXIT.INTERNAL;
  const clean = result.graceful && result.cancelled === 0 && result.unsettled === 0 && (result.flushed === "done" || result.flushed === "unsupported");
  return clean ? EXIT.OK : EXIT.UNSETTLED;
}

/** Closing the store while a handler or the flush may still write would corrupt it (design 8, step 5). */
function storeIsQuiet(result: ShutdownResult | undefined): boolean {
  return result !== undefined && result.unsettled === 0 && result.flushed !== "running";
}

export function installHostLifecycle(options: LifecycleOptions): LifecycleHandle {
  const finalizeMs = options.finalizeTimeoutMs ?? DEFAULT_FINALIZE_MS;
  if (!Number.isInteger(finalizeMs) || finalizeMs < 0 || finalizeMs > MAX_FINALIZE_MS) {
    throw new AxisError("E_INVALID_ARGUMENT", "Invalid finalizeTimeoutMs");
  }
  const target = options.process;
  const signals = [...new Set(options.signals ?? (["SIGTERM", "SIGINT"] as const))];
  const logger = options.logger;
  let triggers = 0;
  let crashed = false;
  let exited = false;
  let removed = false;
  let offMessage: () => void = () => undefined;
  let finish: () => void = () => undefined;
  const finished = new Promise<void>((resolve) => void (finish = resolve));

  const onSignal = (signal: NodeJS.Signals): void => trigger(`signal:${signal}`);
  const onCrash = (): void => crash("uncaughtException");
  const onRejection = (): void => crash("unhandledRejection");
  const remove = (): void => {
    if (removed) return;
    removed = true;
    for (const s of signals) target.off(s, onSignal);
    target.off("uncaughtException", onCrash);
    target.off("unhandledRejection", onRejection);
    offMessage();
  };

  /** The exit hook runs once; if it throws, the crash must not be swallowed: listeners are gone, so this is fatal. */
  const callExit = (code: ExitCode, info: ExitInfo): void => {
    if (exited) return;
    exited = true;
    remove();
    try {
      options.exit(code, info);
    } catch {
      queueMicrotask(() => {
        throw new AxisError("E_INTERNAL", "The exit hook failed");
      });
    } finally {
      finish();
    }
  };

  function crash(origin: "uncaughtException" | "unhandledRejection"): void {
    if (crashed) return;
    crashed = true;
    // Both handlers take no argument on purpose: the thrown value is never read here (a getter or a Proxy would run
    // its code). Only the origin, a fixed literal, is logged.
    try {
      logger?.error("host.crash", { reason: origin });
    } catch {
      // logging must not stop the exit
    }
    callExit(EXIT.INTERNAL, { result: undefined, released: false });
  }

  function trigger(reason: string): void {
    if (++triggers > 1) {
      try {
        options.daemon.escalate();
      } catch {
        // escalation is best effort
      }
      return;
    }
    void shutdown(reason);
  }

  async function shutdown(reason: string): Promise<void> {
    try {
      logger?.info("host.shutdown", { reason: reason.slice(0, 64) });
    } catch {
      // logging must not stop the shutdown
    }
    let result: ShutdownResult | undefined;
    try {
      result = await options.daemon.shutdown(reason);
    } catch {
      result = undefined;
    }
    if (crashed) return;
    let code: ExitCode = exitCodeForShutdown(result);
    let released = false;
    if (storeIsQuiet(result)) {
      if (options.finalize !== undefined && !(await runFinalize(options.finalize, finalizeMs))) {
        if (code === EXIT.OK) code = EXIT.UNSETTLED;
      }
      try {
        const disposed = await options.stop();
        released = true;
        if (disposed.failures.length > 0) {
          if (code === EXIT.OK) code = EXIT.UNSETTLED;
          logger?.warn("dispose.failed", { count: disposed.failures.length });
        }
      } catch {
        if (code === EXIT.OK) code = EXIT.UNSETTLED;
      }
    }
    if (crashed) return;
    callExit(code, { result, released });
  }

  for (const s of signals) target.on(s, onSignal);
  target.on("uncaughtException", onCrash);
  target.on("unhandledRejection", onRejection);
  offMessage = options.control.onShutdown(() => trigger("control:shutdown"));
  return { dispose: remove, finished };
}

/** Run `fn` for at most `ms`; true when it finished in time without throwing. The timer never outlives the call. */
async function runFinalize(fn: () => void | Promise<void>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const work = Promise.resolve().then(fn).then(() => true as const);
    work.catch(() => undefined); // a failure after the bound is not an unhandled rejection
    const bound = new Promise<false>((resolve) => void (timer = setTimeout(() => resolve(false), ms)));
    return await Promise.race([work, bound]);
  } catch {
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
