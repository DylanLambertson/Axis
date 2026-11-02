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

/**
 * An in-memory pair for tests. Messages go through the structured clone
 * algorithm like a real MessagePort, so shared references and class instances
 * behave as they would from an untrusted renderer. `client` is the raw port.
 */
export function memoryPair(): { client: MessagePort; server: Connection } {
  const { port1, port2 } = new MessageChannel();
  return { client: port1, server: fromNodePort(port2) };
}
