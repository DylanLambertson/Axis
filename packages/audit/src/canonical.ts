// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { AxisError } from "./errors.js";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

const MAX_DEPTH = 64;

/**
 * Canonical JSON: object keys sorted by UTF-16 code unit order at every level,
 * no insignificant whitespace, only JSON values. Anything that cannot be
 * represented exactly (undefined, NaN, Infinity, functions, bigint, cycles)
 * is rejected rather than silently dropped, so equal hashes imply equal data.
 */
export function canonicalize(value: unknown): string {
  return encode(value, 0, new Set<object>());
}

function encode(value: unknown, depth: number, seen: Set<object>): string {
  if (depth > MAX_DEPTH) {
    throw new AxisError("E_INVALID_ARGUMENT", "Value is nested too deeply to canonicalise");
  }
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) {
        throw new AxisError("E_INVALID_ARGUMENT", "Non-finite numbers cannot be canonicalised");
      }
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new AxisError("E_INVALID_ARGUMENT", `Cannot canonicalise a value of type ${typeof value}`);
  }
  const obj = value as object;
  if (seen.has(obj)) {
    throw new AxisError("E_INVALID_ARGUMENT", "Cannot canonicalise a circular structure");
  }
  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      return `[${obj.map((item) => encode(item, depth + 1, seen)).join(",")}]`;
    }
    const proto: unknown = Object.getPrototypeOf(obj);
    if (proto !== Object.prototype && proto !== null) {
      throw new AxisError("E_INVALID_ARGUMENT", "Only plain objects can be canonicalised");
    }
    const record = obj as Record<string, unknown>;
    const parts = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${encode(record[key], depth + 1, seen)}`);
    return `{${parts.join(",")}}`;
  } finally {
    seen.delete(obj);
  }
}
