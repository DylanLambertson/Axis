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

export interface DigestInput {
  readonly contract: string;
  readonly op: string;
  readonly target: string;
  /** Output of `canonicalJson` for the request arguments (without `approval`). */
  readonly canonicalArgs: string;
  /** SHA-256 hex of what the operation will destroy. */
  readonly contentDigest: string;
}

/**
 * The digest a challenge is bound to: contract, operation, target, the
 * canonical arguments and the digest of the content that will be destroyed
 * (APR-1, G-24). A JSON array keeps the fields unambiguous (no delimiter
 * injection) and the leading version tag allows a later format.
 */
export function requestDigest(d: DigestInput): string {
  return sha256Hex(JSON.stringify([2, d.contract, d.op, d.target, d.canonicalArgs, d.contentDigest]));
}
