// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { AxisError } from "@axis/audit";
import type { SupervisorChannel, Unsubscribe } from "../ports/index.js";

/**
 * The control channel of a Node child process: the `child_process` IPC channel with JSON serialisation (not
 * `advanced`, so no shared references or exotic types reach the walk of `inspectMessage`). `process` in the child
 * and the `ChildProcess` in the parent both satisfy `IpcLike`, so the host and the test supervisor use the same
 * adapter. It adds listeners only for as long as someone is subscribed, and removes them all in `dispose()`, so the
 * channel no longer keeps the process alive afterwards (the process then exits by draining). Sends are not bounded
 * here, but they are counted: `pending()` is the number of messages handed to `send` whose write callback has not run
 * yet, and `onDrain` fires when it is back to zero. The web host (W1, `src/web/`) stops reading its sockets while the
 * count is at its bound, so a slow peer cannot make the parent buffer without limit. A `send` that never calls back
 * stays pending, which only ever stalls the web host (fails closed).
 */
export interface IpcLike {
  send?(message: unknown, callback?: (error: Error | null) => void): boolean;
  connected?: boolean;
  on(event: "message", listener: (message: unknown) => void): unknown;
  on(event: "disconnect", listener: () => void): unknown;
  off(event: "message", listener: (message: unknown) => void): unknown;
  off(event: "disconnect", listener: () => void): unknown;
}

export interface DisposableChannel extends SupervisorChannel {
  /** Remove every listener and report the close to subscribers once. Idempotent. */
  dispose(): void;
}

/** The backlog of a channel whose writes complete later (the Node IPC channel). */
export interface ChannelFlow {
  /** Messages handed to `send` that the channel has not written yet. */
  pending(): number;
  /** Called each time `pending()` falls back to zero. */
  onDrain(handler: () => void): Unsubscribe;
}

const closedError = (): AxisError => new AxisError("E_UNAVAILABLE", "The channel is closed", { reason: "channel_closed" });

export function adaptNodeIpc(proc: IpcLike): DisposableChannel & ChannelFlow {
  const messageHandlers: Array<(m: unknown) => void> = [];
  const closeHandlers: Array<() => void> = [];
  const drainHandlers: Array<() => void> = [];
  let closed = false;
  let pending = 0;
  const written = (): void => {
    pending--;
    if (pending === 0) for (const h of [...drainHandlers]) safe(h);
  };

  const onMessage = (m: unknown): void => {
    for (const h of [...messageHandlers]) safe(() => h(m));
  };
  const finish = (): void => {
    if (closed) return;
    closed = true;
    proc.off("message", onMessage);
    proc.off("disconnect", finish);
    messageHandlers.length = 0;
    drainHandlers.length = 0;
    for (const h of closeHandlers.splice(0)) safe(h);
  };
  proc.on("message", onMessage);
  proc.on("disconnect", finish);

  const remove = <T>(list: T[], item: T): Unsubscribe => () => {
    const i = list.indexOf(item);
    if (i >= 0) list.splice(i, 1);
  };

  return {
    send(message: unknown): void {
      if (closed || proc.connected === false || typeof proc.send !== "function") throw closedError();
      pending++;
      let done = false;
      const callback = (): void => {
        if (done) return;
        done = true;
        written();
      };
      try {
        proc.send(message, callback);
      } catch {
        callback();
        throw closedError();
      }
    },
    pending: () => pending,
    onDrain(handler): Unsubscribe {
      drainHandlers.push(handler);
      return remove(drainHandlers, handler);
    },
    onMessage(handler): Unsubscribe {
      messageHandlers.push(handler);
      return remove(messageHandlers, handler);
    },
    onClose(handler): Unsubscribe {
      closeHandlers.push(handler);
      return remove(closeHandlers, handler);
    },
    dispose: finish,
  };
}

function safe(fn: () => void): void {
  try {
    fn();
  } catch {
    // One failing handler must not break the others.
  }
}
