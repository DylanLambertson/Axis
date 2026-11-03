// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { createHash, randomBytes } from "node:crypto";
import type { JsonValue } from "@axis/protocol";

export const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
export const newCorrelationId = (): string => randomBytes(8).toString("hex");

/**
 * Canonical JSON text of a bounded JSON value: object keys sorted by UTF-16
 * code unit at every depth, arrays in order, no whitespace. Built as a string
 * (never through a JS object) so integer-like keys keep code-unit order and
 * the text is reproducible in any language.
 */
export function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v as JsonValue)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const o = value as Record<string, JsonValue>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k] as JsonValue)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function withoutApproval(payload: JsonValue): JsonValue {
  if (payload !== null && typeof payload === "object" && !Array.isArray(payload) && "approval" in payload) {
    const { approval: _ignored, ...rest } = payload as Record<string, JsonValue>;
    return rest;
  }
  return payload;
}

/** Hash of a payload without its `approval` field, so a retry carrying a challenge id still matches. */
export const payloadHash = (payload: JsonValue): string => sha256Hex(canonicalJson(withoutApproval(payload)));

/** Domain-separation tag of the request digest. Changing the digest layout means a new tag. */
export const REQUEST_DIGEST_TAG = "axis.request/1";

/**
 * The one request digest an approval is bound to (shared with `@axis/challenge`):
 *
 *   sha256_hex(JSON.stringify(["axis.request/1", contract, version, method, canonicalJson(payloadWithoutApproval)]))
 *
 * `contract` is the bare contract id from the envelope ("axis.worktrees"),
 * `version` the integer contractVersion. `payloadWithoutApproval` drops only
 * the top-level `approval` field, and the canonical text is embedded as a
 * JSON string. The daemon computes this; the gate compares it, it never
 * recomputes its own.
 */
export function requestDigest(contract: string, version: number, method: string, payload: JsonValue): string {
  return sha256Hex(JSON.stringify([REQUEST_DIGEST_TAG, contract, version, method, canonicalJson(withoutApproval(payload))]));
}
