// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { AxisError } from "@axis/audit";
import type { StoreKey } from "./idempotency-store.js";

const MAX_FIELD = 512;

/** Validate an option: a safe positive integer no greater than `max`. */
export function positive(n: number, name: string, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(n) || n <= 0 || n > max) throw new AxisError("E_INVALID_ARGUMENT", `${name} must be a positive integer within its limit`);
  return n;
}

export function parts(k: StoreKey): [string, string, string, number, string, string] {
  const text = (v: unknown, name: string, allowEmpty = false): string => {
    if (typeof v !== "string" || (!allowEmpty && v.length === 0) || v.length > MAX_FIELD) {
      throw new AxisError("E_INVALID_ARGUMENT", `Idempotency key field ${name} is invalid`);
    }
    return v;
  };
  if (!Number.isSafeInteger(k.version) || k.version < 0) throw new AxisError("E_INVALID_ARGUMENT", "Idempotency key field version is invalid");
  return [text(k.actorId, "actorId"), text(k.workspaceId, "workspaceId", true), text(k.contract, "contract"), k.version, text(k.method, "method"), text(k.key, "key")];
}
