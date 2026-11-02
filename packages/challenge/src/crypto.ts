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
 * The digest a challenge is bound to: operation, target and the digest of the
 * content that will be destroyed. A JSON array keeps the fields unambiguous
 * (no delimiter injection) and the version tag allows a later format.
 */
export function requestDigest(op: string, target: string, contentDigest: string): string {
  return sha256Hex(JSON.stringify([1, op, target, contentDigest]));
}
