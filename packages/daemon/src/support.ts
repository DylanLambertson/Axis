// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { createHash, randomBytes } from "node:crypto";
import { contracts, lookupMethod, type JsonValue } from "@axis/protocol";
import type {
  ContractRegistry,
  IdempotencyBegin,
  IdempotencyKey,
  IdempotencyStore,
} from "./types.js";

/** Canonical JSON for bounded JSON values: sorted keys, no whitespace. */
export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v as JsonValue)).join(",")}]`;
  const rec = value as Record<string, JsonValue>;
  return `{${Object.keys(rec)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(rec[k] as JsonValue)}`)
    .join(",")}}`;
}

export const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
export const newCorrelationId = (): string => randomBytes(8).toString("hex");

/** Hash of a payload without its `approval` field, so a retry carrying a challenge id still matches. */
export function payloadHash(payload: JsonValue): string {
  if (payload !== null && typeof payload === "object" && !Array.isArray(payload) && "approval" in payload) {
    const { approval: _ignored, ...rest } = payload as Record<string, JsonValue>;
    return sha256Hex(canonicalJson(rest));
  }
  return sha256Hex(canonicalJson(payload));
}

/** Token bucket with an injected clock. */
export class RateLimiter {
  #tokens: number;
  #last: number;
  constructor(
    private readonly ratePerSecond: number,
    private readonly burst: number,
    private readonly now: () => number,
  ) {
    this.#tokens = burst;
    this.#last = now();
  }
  tryTake(): boolean {
    const t = this.now();
    this.#tokens = Math.min(this.burst, this.#tokens + ((t - this.#last) * this.ratePerSecond) / 1000);
    this.#last = t;
    if (this.#tokens < 1) return false;
    this.#tokens -= 1;
    return true;
  }
}

/** The registry the product uses: `@axis/protocol`'s contract table. */
export const protocolRegistry: ContractRegistry = {
  lookup: lookupMethod,
  versions(contract) {
    const out: number[] = [];
    for (const key of Object.keys(contracts)) {
      const slash = key.lastIndexOf("/");
      if (key.slice(0, slash) === contract) out.push(Number(key.slice(slash + 1)));
    }
    return out.sort((a, b) => a - b);
  },
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** In-memory idempotency store (24 h, bounded). The journal-backed store replaces it. */
export class MemoryIdempotencyStore implements IdempotencyStore {
  readonly #entries = new Map<string, { hash: string; result?: JsonValue; at: number }>();
  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = DAY_MS,
    private readonly maxEntries: number = 10_000,
  ) {}

  #id(k: IdempotencyKey): string {
    return JSON.stringify([k.actorId, k.contract, k.version, k.method, k.key]);
  }

  begin(key: IdempotencyKey, hash: string): IdempotencyBegin {
    const id = this.#id(key);
    const t = this.now();
    for (const [k, e] of this.#entries) if (t - e.at >= this.ttlMs) this.#entries.delete(k);
    const found = this.#entries.get(id);
    if (found) {
      if (found.hash !== hash) return { state: "conflict" };
      return found.result === undefined ? { state: "in-progress" } : { state: "replay", result: found.result };
    }
    if (this.#entries.size >= this.maxEntries) {
      const oldest = this.#entries.keys().next().value;
      if (oldest !== undefined) this.#entries.delete(oldest);
    }
    this.#entries.set(id, { hash, at: t });
    return { state: "new" };
  }

  complete(key: IdempotencyKey, result: JsonValue): void {
    const e = this.#entries.get(this.#id(key));
    if (e) e.result = result;
  }

  abandon(key: IdempotencyKey): void {
    const id = this.#id(key);
    if (this.#entries.get(id)?.result === undefined) this.#entries.delete(id);
  }
}
