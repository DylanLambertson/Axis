// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
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

export const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
