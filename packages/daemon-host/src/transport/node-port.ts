// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { AxisError } from "@axis/audit";
import type { SupervisorChannel, Unsubscribe } from "../ports/index.js";
import type { DisposableChannel } from "./node-ipc.js";

/**
 * The control channel of a worker thread (fast in-process tests): a `MessagePort`, or a `Worker`, which has the same
 * `postMessage`/`on`/`off` shape. Messages arrive as the data itself.
 */
export interface PortLike {
  postMessage(message: unknown): void;
  on(event: "message", listener: (message: unknown) => void): unknown;
  on(event: "close" | "exit", listener: () => void): unknown;
  off(event: "message", listener: (message: unknown) => void): unknown;
  off(event: "close" | "exit", listener: () => void): unknown;
}

export function adaptNodePort(port: PortLike, closeEvent: "close" | "exit" = "close"): DisposableChannel {
  const messageHandlers: Array<(m: unknown) => void> = [];
  const closeHandlers: Array<() => void> = [];
  let closed = false;

  const onMessage = (m: unknown): void => {
    for (const h of [...messageHandlers]) {
      try {
        h(m);
      } catch {
        // One failing handler must not break the others.
      }
    }
  };
  const finish = (): void => {
    if (closed) return;
    closed = true;
    port.off("message", onMessage);
    port.off(closeEvent, finish);
    messageHandlers.length = 0;
    for (const h of closeHandlers.splice(0)) {
      try {
        h();
      } catch {
        // Ignored.
      }
    }
  };
  port.on("message", onMessage);
  port.on(closeEvent, finish);

  const remove = <T>(list: T[], item: T): Unsubscribe => () => {
    const i = list.indexOf(item);
    if (i >= 0) list.splice(i, 1);
  };

  const channel: SupervisorChannel = {
    send(message: unknown): void {
      if (closed) throw new AxisError("E_UNAVAILABLE", "The channel is closed", { reason: "channel_closed" });
      try {
        port.postMessage(message);
      } catch {
        throw new AxisError("E_UNAVAILABLE", "The channel is closed", { reason: "channel_closed" });
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
  };
  return { ...channel, dispose: finish };
}
