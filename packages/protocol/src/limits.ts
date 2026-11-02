// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { z } from "zod";

/**
 * Bounds enforced in one walk over a decoded message, before any schema runs
 * (ADR 0003 D2.1, ADR 0005 D4). The walk works on structured-clone input,
 * where no byte length is known, so sizes are approximated from the values.
 */
export const MAX_MESSAGE_BYTES = 1_048_576;
export const MAX_STRING_BYTES = 262_144;
export const MAX_MESSAGE_NODES = 10_000;
/** Nesting levels of objects and arrays, counting the root as level 1. */
export const MAX_DEPTH = 16;

/** Keys that are never accepted anywhere in a message (ADR 0003 D2.4). */
export const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

export type InspectFailure =
  | "forbidden-key"
  | "too-deep"
  | "too-large"
  | "too-many-nodes"
  | "shared-reference"
  | "invalid";

export type InspectResult = { ok: true } | { ok: false; reason: InspectFailure };

export interface InspectLimits {
  readonly maxBytes?: number;
  readonly maxNodes?: number;
  readonly maxDepth?: number;
  readonly maxStringBytes?: number;
}

/** UTF-8 length of a string, exact, with an early exit above `cap`. */
function utf8Length(s: string, cap: number): number {
  // Every UTF-16 code unit is at least one UTF-8 byte, so this is a safe early exit.
  if (s.length > cap) return s.length;
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        bytes += 4;
        i++;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * One bounded, iterative walk. Rejects:
 * - values JSON cannot carry (undefined, functions, symbols, bigint, non-finite
 *   numbers, class instances such as Date or Map);
 * - forbidden keys at any depth;
 * - any object reached twice. A structured-clone MessagePort preserves shared
 *   references, so a tiny message can expand into an exponential tree; decoded
 *   JSON is always a tree, so a revisit (a DAG or a cycle) is hostile;
 * - more than `maxNodes` values, `maxDepth` levels, `maxStringBytes` in one
 *   string or `maxBytes` in total (strings and keys by UTF-8 length, other
 *   values by a small fixed charge).
 */
export function inspectMessage(value: unknown, limits: InspectLimits = {}): InspectResult {
  const maxBytes = limits.maxBytes ?? MAX_MESSAGE_BYTES;
  const maxNodes = limits.maxNodes ?? MAX_MESSAGE_NODES;
  const maxDepth = limits.maxDepth ?? MAX_DEPTH;
  const maxString = limits.maxStringBytes ?? MAX_STRING_BYTES;
  const seen = new WeakSet<object>();
  const stack: Array<[unknown, number]> = [[value, 1]];
  let nodes = 0;
  let bytes = 0;

  while (stack.length > 0) {
    const [node, depth] = stack.pop() as [unknown, number];
    if (++nodes > maxNodes) return { ok: false, reason: "too-many-nodes" };

    switch (typeof node) {
      case "string": {
        const n = utf8Length(node, maxString);
        if (n > maxString) return { ok: false, reason: "too-large" };
        bytes += n + 2;
        break;
      }
      case "number":
        if (!Number.isFinite(node)) return { ok: false, reason: "invalid" };
        bytes += 8;
        break;
      case "boolean":
        bytes += 5;
        break;
      case "object": {
        if (node === null) {
          bytes += 4;
          break;
        }
        if (depth > maxDepth) return { ok: false, reason: "too-deep" };
        if (seen.has(node)) return { ok: false, reason: "shared-reference" };
        seen.add(node);
        bytes += 2;
        if (Array.isArray(node)) {
          if (node.length + nodes > maxNodes) return { ok: false, reason: "too-many-nodes" };
          for (const item of node) stack.push([item, depth + 1]);
          break;
        }
        const proto = Object.getPrototypeOf(node) as unknown;
        if (proto !== Object.prototype && proto !== null) return { ok: false, reason: "invalid" };
        if (Object.getOwnPropertySymbols(node).length > 0) return { ok: false, reason: "invalid" };
        const keys = Object.getOwnPropertyNames(node);
        if (keys.length + nodes > maxNodes) return { ok: false, reason: "too-many-nodes" };
        for (const key of keys) {
          if (FORBIDDEN_KEYS.has(key)) return { ok: false, reason: "forbidden-key" };
          const kb = utf8Length(key, maxString);
          if (kb > maxString) return { ok: false, reason: "too-large" };
          bytes += kb + 4;
          stack.push([(node as Record<string, unknown>)[key], depth + 1]);
        }
        break;
      }
      default:
        return { ok: false, reason: "invalid" };
    }
    if (bytes > maxBytes) return { ok: false, reason: "too-large" };
  }
  return { ok: true };
}

export type JsonValue = z.core.util.JSONType;

/**
 * A bounded JSON value for payloads, results and error details. It uses the
 * walk above instead of `z.json()`, so no recursive schema runs over input
 * that has not been bounded.
 */
export const boundedJsonSchema = z.custom<JsonValue>((v) => inspectMessage(v).ok, {
  message: "not a bounded JSON value",
});
