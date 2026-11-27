// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { Channel, Disposable } from "./ports.js";

/**
 * A MessagePort as a structural type, so nothing here imports `electron` or `node:worker_threads` (staged packages may not, ADR 0005).
 * Electron's `MessagePortMain` delivers `{ data, ports }` events; a Node `MessagePort` delivers the data itself (`shape: "node"`).
 */
export interface MessagePortLike {
  on(event: "message" | "close", listener: (arg: never) => void): unknown;
  removeListener(event: "message" | "close", listener: (arg: never) => void): unknown;
  postMessage(message: unknown): void;
  close(): void;
  /** `MessagePortMain` queues messages until `start()`; a Node port starts when a `message` listener is added. */
  start?(): void;
}

export interface PortAdapterOptions {
  readonly shape: "electron" | "node";
  /**
   * Extra reasons the channel is over (a utility process's `parentPort` has no `close` event: pass process exit). The function
   * receives the callback to call and returns what to undo. Without it only the port's own `close` event closes the channel.
   */
  readonly closeOn?: (fire: () => void) => Disposable;
}

const quiet = (fn: () => void): void => {
  try {
    fn();
  } catch {
    /* already closed, or a listener that threw: neither may stop the others */
  }
};

/**
 * Adapts one port to the service's `Channel`. A message that arrives with transferred ports (Electron `ports`) is dropped and every
 * port closed: no message of the pty protocol carries one, and a port nobody owns would be a hidden path to a terminal. After the
 * channel is closed (by `close()`, by the port's `close` event or by `closeOn`) `send` throws, the listeners are removed and the
 * close listeners run once.
 */
export function adaptMessagePort(port: MessagePortLike, options: PortAdapterOptions): Channel {
  const messageListeners = new Set<(message: unknown) => void>();
  const closeListeners = new Set<() => void>();
  let closed = false;
  let closeSubscription: Disposable | undefined;

  const onMessage = (event: unknown): void => {
    if (closed) return;
    let data: unknown = event;
    if (options.shape === "electron") {
      const e = event as { data?: unknown; ports?: readonly MessagePortLike[] } | null;
      const ports = e !== null && typeof e === "object" && Array.isArray(e.ports) ? e.ports : [];
      if (ports.length > 0) {
        for (const p of ports) quiet(() => p.close());
        return;
      }
      data = e !== null && typeof e === "object" ? e.data : undefined;
    }
    for (const l of [...messageListeners]) quiet(() => l(data));
  };
  const finish = (closePort: boolean): void => {
    if (closed) return;
    closed = true;
    quiet(() => port.removeListener("message", onMessage));
    quiet(() => port.removeListener("close", onClose));
    if (closeSubscription !== undefined) quiet(() => closeSubscription?.dispose());
    messageListeners.clear();
    if (closePort) quiet(() => port.close());
    for (const l of [...closeListeners]) quiet(l);
    closeListeners.clear();
  };
  const onClose = (): void => finish(false);

  port.on("message", onMessage);
  port.on("close", onClose);
  if (options.closeOn !== undefined) closeSubscription = options.closeOn(() => finish(true));
  quiet(() => port.start?.());

  return {
    send(message) {
      if (closed) throw new Error("channel closed");
      port.postMessage(message);
    },
    onMessage(listener) {
      messageListeners.add(listener);
      return { dispose: () => void messageListeners.delete(listener) };
    },
    onClose(listener) {
      if (closed) {
        quiet(listener);
        return { dispose: () => undefined };
      }
      closeListeners.add(listener);
      return { dispose: () => void closeListeners.delete(listener) };
    },
    close() {
      finish(true);
    },
  };
}
