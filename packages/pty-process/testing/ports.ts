// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { MessageChannel, type MessagePort } from "node:worker_threads";
import type { MessagePortLike } from "../src/index.js";

/** TEST ONLY. Wraps a Node `MessagePort` so it looks like Electron's `MessagePortMain` (events are `{ data, ports }`). */
export function electronShaped(port: MessagePort, counters?: { closed: number }): MessagePortLike {
  const wrapped = new Map<unknown, (data: unknown) => void>();
  return {
    on(event: string, listener: unknown): unknown {
      if (event === "message") {
        const fn = (data: unknown): void => (listener as (e: unknown) => void)({ data, ports: [] });
        wrapped.set(listener, fn);
        return port.on("message", fn);
      }
      return port.on("close", listener as () => void);
    },
    removeListener(event: string, listener: unknown): unknown {
      if (event === "message") return port.off("message", (wrapped.get(listener) ?? listener) as (v: unknown) => void);
      return port.off("close", listener as () => void);
    },
    postMessage: (m: unknown) => port.postMessage(m),
    close: () => {
      if (counters !== undefined) counters.closed++;
      port.close();
    },
  } as MessagePortLike;
}

export function nodePair(): { a: MessagePort; b: MessagePort } {
  const { port1, port2 } = new MessageChannel();
  return { a: port1, b: port2 };
}

/** TEST ONLY. A port that records its listeners and what was done to it. */
export class RecordingPort implements MessagePortLike {
  readonly message = new Set<(arg: never) => void>();
  readonly closeL = new Set<(arg: never) => void>();
  readonly posted: unknown[] = [];
  closes = 0;
  on(event: "message" | "close", listener: (arg: never) => void): unknown {
    (event === "message" ? this.message : this.closeL).add(listener);
    return this;
  }
  removeListener(event: "message" | "close", listener: (arg: never) => void): unknown {
    (event === "message" ? this.message : this.closeL).delete(listener);
    return this;
  }
  postMessage(m: unknown): void { this.posted.push(m); }
  close(): void { this.closes++; }
  deliver(event: unknown): void { for (const l of [...this.message]) (l as (e: unknown) => void)(event); }
  fireClose(): void { for (const l of [...this.closeL]) (l as () => void)(); }
}

/** TEST ONLY. A Node `MessagePort` as the structural type (its `on` overloads do not unify with it; the runtime shape does). */
export const nodeShaped = (port: MessagePort): MessagePortLike => port as unknown as MessagePortLike;
