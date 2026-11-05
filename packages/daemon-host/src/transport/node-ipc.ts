// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { AxisError } from "@axis/audit";
import type { SupervisorChannel, Unsubscribe } from "../ports/index.js";

/**
 * The control channel of a Node child process: the `child_process` IPC channel with JSON serialisation (not
 * `advanced`, so no shared references or exotic types reach the walk of `inspectMessage`). `process` in the child
 * and the `ChildProcess` in the parent both satisfy `IpcLike`, so the host and the test supervisor use the same
 * adapter. It adds listeners only for as long as someone is subscribed, and removes them all in `dispose()`, so the
 * channel no longer keeps the process alive afterwards (the process then exits by draining).
 */
export interface IpcLike {
  send?(message: unknown): boolean;
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

const closedError = (): AxisError => new AxisError("E_UNAVAILABLE", "The channel is closed", { reason: "channel_closed" });

export function adaptNodeIpc(proc: IpcLike): DisposableChannel {
  const messageHandlers: Array<(m: unknown) => void> = [];
  const closeHandlers: Array<() => void> = [];
  let closed = false;

  const onMessage = (m: unknown): void => {
    for (const h of [...messageHandlers]) safe(() => h(m));
  };
  const finish = (): void => {
    if (closed) return;
    closed = true;
    proc.off("message", onMessage);
    proc.off("disconnect", finish);
    messageHandlers.length = 0;
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
      try {
        proc.send(message);
      } catch {
        throw closedError();
      }
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
