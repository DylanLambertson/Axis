// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** 256 random bits as 43 base64url characters. */
export const randomToken = (): string => randomBytes(32).toString("base64url");

/**
 * Constant-time string equality. Both sides are hashed first so the compared
 * buffers always have equal length and the length of a secret is not leaked.
 */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Canonical JSON for request arguments: object keys sorted (by UTF-16 code
 * unit) at every depth, arrays in order, no whitespace. Two argument trees are
 * equal exactly when their canonical strings are. Input must already be a
 * bounded JSON value (plain objects, arrays, finite numbers, strings,
 * booleans, null); that is checked by `argsSchema`, not here.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export interface RequestDigestInput {
  readonly contract: string;
  readonly version: number;
  readonly method: string;
  /** The request params without the `approval` field. */
  readonly payload: unknown;
}

/**
 * The canonical request digest shared with the daemon (APR-1, G-24):
 * `sha256hex(JSON.stringify(["axis.request/1", contract, version, method, canonical(payload)]))`,
 * where `canonical` sorts object keys recursively and allows JSON primitives only.
 * TODO: dedupe into @axis/protocol once the daemon's copy and the shared vectors land.
 */
export function requestDigest(d: RequestDigestInput): string {
  return sha256Hex(JSON.stringify(["axis.request/1", d.contract, d.version, d.method, canonicalJson(d.payload)]));
}

export interface ChallengeDigestInput {
  /** `requestDigest` of the request being approved. */
  readonly requestDigest: string;
  readonly target: string;
  /** SHA-256 hex of what the operation will destroy. */
  readonly contentDigest: string;
}

/**
 * The digest shown on the challenge and echoed by the renderer: the request
 * digest, the target and the content digest (G-24: a request, target or
 * content altered after approval is refused).
 */
export function challengeDigest(d: ChallengeDigestInput): string {
  return sha256Hex(JSON.stringify([3, d.requestDigest, d.target, d.contentDigest]));
}
