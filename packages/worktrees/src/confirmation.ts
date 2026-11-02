// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

declare const verifiedBrand: unique symbol;

/**
 * Opaque proof that a user discard confirmation (challenge plus native
 * dialog, task B4) already succeeded. This package never verifies it; it only
 * checks that the value was minted by `markDiscardConfirmed`, so a value that
 * crossed a JSON boundary or was hand-built cannot satisfy the check.
 */
export interface DiscardConfirmation {
  readonly [verifiedBrand]: true;
}

const minted = new WeakSet<object>();

/** To be called only by the daemon after B4 verification succeeded. */
export function markDiscardConfirmed(): DiscardConfirmation {
  const token = Object.freeze({}) as DiscardConfirmation;
  minted.add(token);
  return token;
}

export function isDiscardConfirmed(value: unknown): value is DiscardConfirmation {
  return typeof value === 'object' && value !== null && minted.has(value);
}
