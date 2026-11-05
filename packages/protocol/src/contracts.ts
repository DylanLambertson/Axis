// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { WORKTREES_CONTRACT, WORKTREES_VERSION, worktreesMethods, type MethodSpec } from "./worktrees.js";

/** Every contract this build serves, keyed `<id>/<major>`. */
export const contracts: Readonly<Record<string, Readonly<Record<string, MethodSpec>>>> = {
  [`${WORKTREES_CONTRACT}/${WORKTREES_VERSION}`]: worktreesMethods,
};

/** The method's spec, or undefined (the daemon answers E_METHOD_NOT_FOUND). */
export function lookupMethod(contract: string, version: number, method: string): MethodSpec | undefined {
  const methods = contracts[`${contract}/${version}`];
  return methods !== undefined && Object.hasOwn(methods, method) ? methods[method] : undefined;
}

/**
 * The envelope marks `idempotencyKey` optional because the requirement is
 * per method. The daemon MUST refuse a request without one when this returns
 * true (E_INVALID_ARGUMENT); nothing in the schema enforces it.
 */
export function requiresIdempotencyKey(contract: string, version: number, method: string): boolean {
  return lookupMethod(contract, version, method)?.idempotency === "required";
}
