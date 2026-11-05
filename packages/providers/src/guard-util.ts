// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

/** A limit: `undefined` means the default; anything else must be a positive safe integer at most `max` (S7). */
export function limitOf(name: string, value: unknown, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new RangeError(`guard limit ${name} must be an integer from 1 to ${max}`);
  }
  return value;
}

export function read(o: object, key: string): unknown {
  try {
    return (o as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}
