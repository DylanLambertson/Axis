// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { Clock } from "../src/index.js";

/** A valid init payload; `over` replaces or adds keys. A random key per call, as the supervisor would send. */
export function validConfig(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    dataDir: "/data/axis",
    worktreeRoot: "/data/worktrees",
    platform: "linux",
    attestationKey: randomBytes(32).toString("base64url"),
    ...over,
  };
}

export function fakeClock(start = 1_700_000_000_000): Clock & { advance(ms: number): void } {
  let t = start;
  return { now: () => t, monotonic: () => t, advance: (ms) => void (t += ms) };
}

/** What a process holds that could keep it alive or leak: active resources and listeners on `process`. */
export function processSnapshot(): { resources: string[]; listeners: Record<string, number> } {
  const listeners: Record<string, number> = {};
  for (const name of process.eventNames()) listeners[String(name)] = process.listenerCount(name);
  return { resources: process.getActiveResourcesInfo().filter((r) => r === "Timeout" || r === "Immediate").sort(), listeners };
}

/**
 * "Nothing extra is alive after cleanup" is a negative claim, so it is asserted ONCE after letting what must terminate by
 * itself do so (closing handles finish within a couple of macrotasks): never polled, or a leak that expires on its own
 * inside a polling window would be waited out and pass.
 */
export async function settledTo(before: ReturnType<typeof processSnapshot>, message?: string): Promise<void> {
  await drain();
  assert.deepEqual(processSnapshot(), before, message);
}

/** Two macrotasks: every promise continuation and every process-level rejection report queued so far has run. Not a duration. */
export const drain = async (): Promise<void> => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
};

export const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Wait by condition (event loop turns); the bound only turns a stuck test into a failure, and a busy host reaches the condition late, not wrongly. */
export async function untilTrue(pred: () => boolean, what: string, guardMs = 60_000): Promise<void> {
  const deadline = Date.now() + guardMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`condition not reached: ${what}`);
    await new Promise((r) => setImmediate(r));
  }
}

/**
 * Count the timers created and not yet fired or cleared while it is installed. `getActiveResourcesInfo` does not
 * list `unref`ed timers, so it cannot see a leaked one; this does. Call `restore()` in a `finally`.
 */
export function trackTimers(): { live(): number; restore(): void } {
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  const live = new Set<unknown>();
  globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    const h = realSet(
      (...a: unknown[]) => {
        live.delete(h);
        fn(...a);
      },
      ms,
      ...args,
    );
    live.add(h);
    return h;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((h: unknown) => {
    live.delete(h);
    realClear(h as NodeJS.Timeout);
  }) as typeof clearTimeout;
  return { live: () => live.size, restore: () => void ((globalThis.setTimeout = realSet), (globalThis.clearTimeout = realClear)) };
}

/** Narrow a possibly absent service (absent only when the host is degraded) or fail the test. */
export function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("expected a defined value");
  return value;
}
