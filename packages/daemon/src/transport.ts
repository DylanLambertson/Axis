// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { MessageChannel, type MessagePort } from "node:worker_threads";
import type { Connection } from "./types.js";

/** Adapts a `node:worker_threads` MessagePort (messages arrive as the data itself). */
export function fromNodePort(port: MessagePort): Connection {
  return {
    send: (m) => port.postMessage(m),
    onMessage: (h) => void port.on("message", h),
    onClose: (h) => void port.on("close", h),
    close: () => port.close(),
  };
}

/** The part of Electron's `MessagePortMain` the daemon uses: messages arrive as `{ data, ports }`. */
export interface ElectronPortLike {
  on(event: "message", listener: (event: { data: unknown; ports: ReadonlyArray<{ close(): void }> }) => void): unknown;
  on(event: "close", listener: () => void): unknown;
  postMessage(message: unknown): void;
  start(): void;
  close(): void;
}

/**
 * Adapts an Electron `MessagePortMain`. Only `event.data` is delivered; any
 * port a peer transfers along with a message is closed and ignored, so a
 * renderer cannot smuggle a channel to something else through the daemon.
 */
export function fromElectronPort(port: ElectronPortLike): Connection {
  return {
    send: (m) => port.postMessage(m),
    onMessage: (h) => {
      port.on("message", (event) => {
        for (const extra of event.ports ?? []) {
          try {
            extra.close();
          } catch {
            // already closed
          }
        }
        h(event.data);
      });
      port.start();
    },
    onClose: (h) => void port.on("close", h),
    close: () => port.close(),
  };
}

/**
 * An in-memory pair for tests. Messages go through the structured clone
 * algorithm like a real MessagePort, and the server side is seen through the
 * same `{ data, ports }` event shape as Electron's `MessagePortMain`, via
 * `fromElectronPort`. `client` is the raw port.
 */
export function memoryPair(): { client: MessagePort; server: Connection } {
  const { port1, port2 } = new MessageChannel();
  const shim: ElectronPortLike = {
    on(event: string, listener: unknown): unknown {
      if (event === "message") {
        const deliver = listener as (e: { data: unknown; ports: [] }) => void;
        return port2.on("message", (data: unknown) => deliver({ data, ports: [] }));
      }
      return port2.on("close", listener as () => void);
    },
    postMessage: (m) => port2.postMessage(m),
    start: () => port2.start(),
    close: () => port2.close(),
  };
  return { client: port1, server: fromElectronPort(shim) };
}
