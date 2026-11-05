// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { SupervisorChannel, Unsubscribe } from "../src/index.js";

/**
 * Two ends of an in-memory ordered channel for tests. A message is structured-cloned (as a real port or a JSON
 * channel would) and delivered on a microtask, in order. `listeners()` counts the handlers still attached on an end,
 * so a test can assert that nothing was left behind.
 */
export interface MemoryEnd extends SupervisorChannel {
  /** Close the channel: both ends see `onClose` once; later `send` throws. */
  close(): void;
  listeners(): number;
  /** Deliver `message` to this end's handlers as if the peer had sent it, without cloning it (for hostile shapes). */
  inject(message: unknown): void;
}

export function memoryChannelPair(): { a: MemoryEnd; b: MemoryEnd } {
  let closed = false;
  const makeEnd = (): { end: MemoryEnd; deliver: (m: unknown, clone: boolean) => void; fireClose: () => void } => {
    const messages: Array<(m: unknown) => void> = [];
    const closes: Array<() => void> = [];
    const remove = <T>(list: T[], item: T): Unsubscribe => () => {
      const i = list.indexOf(item);
      if (i >= 0) list.splice(i, 1);
    };
    const deliver = (m: unknown, clone: boolean): void => {
      const value = clone ? structuredClone(m) : m;
      queueMicrotask(() => {
        for (const h of [...messages]) h(value);
      });
    };
    const end: MemoryEnd = {
      send: () => undefined,
      onMessage: (h) => (messages.push(h), remove(messages, h)),
      onClose: (h) => (closes.push(h), remove(closes, h)),
      close: () => undefined,
      listeners: () => messages.length + closes.length,
      inject: (m) => deliver(m, false),
    };
    const fireClose = (): void => {
      for (const h of closes.splice(0)) h();
    };
    return { end, deliver, fireClose };
  };
  const a = makeEnd();
  const b = makeEnd();
  const wire = (from: ReturnType<typeof makeEnd>, to: ReturnType<typeof makeEnd>): void => {
    from.end.send = (m: unknown): void => {
      if (closed) throw new Error("closed");
      to.deliver(m, true);
    };
    from.end.close = (): void => {
      if (closed) return;
      closed = true;
      queueMicrotask(() => {
        from.fireClose();
        to.fireClose();
      });
    };
  };
  wire(a, b);
  wire(b, a);
  return { a: a.end, b: b.end };
}
