// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

declare const verifiedBrand: unique symbol;

export type DiscardOp = 'finalise' | 'remove';

/** What the user actually confirmed. */
export interface DiscardBinding {
  readonly workspaceId: string;
  readonly op: DiscardOp;
  /** Digest of the dirty files plus the files a backup cannot hold (see `previewDiscard`). */
  readonly fingerprint: string;
}

/**
 * Opaque proof that a user discard confirmation (challenge plus native
 * dialog, task B4) already succeeded for one workspace, one operation and one
 * exact set of affected files. This package never verifies the dialog; it only
 * checks the value was minted by the daemon-only `markDiscardConfirmed`, still
 * matches the binding, and has not been used. A value that crossed a JSON
 * boundary or was hand-built cannot satisfy the check.
 */
export interface DiscardConfirmation {
  readonly [verifiedBrand]: true;
}

interface State {
  readonly binding: DiscardBinding;
  readonly now: () => number;
  readonly expiresAt: number;
  spent: boolean;
}

/** Default lifetime of a confirmation, measured on a monotonic clock. */
export const CONFIRMATION_TTL_MS = 30_000;

export interface ConfirmationOptions {
  /** Monotonic clock in ms (default `performance.now`); a test seam. Wall-clock changes never extend a token. */
  readonly now?: () => number;
  readonly ttlMs?: number;
}

const minted = new WeakMap<object, State>();

/** Internal: used by `daemonConfirm.ts`, which is the only minting entry point. */
export function registerConfirmation(binding: DiscardBinding, opts: ConfirmationOptions = {}): DiscardConfirmation {
  const token = Object.freeze({}) as DiscardConfirmation;
  const now = opts.now ?? (() => performance.now());
  minted.set(token, { binding: { ...binding }, now, expiresAt: now() + (opts.ttlMs ?? CONFIRMATION_TTL_MS), spent: false });
  return token;
}

export type ConsumeResult = 'ok' | 'invalid' | 'mismatch' | 'spent' | 'expired';

/** Checks the binding and marks the token used when it matches. */
export function consumeConfirmation(value: unknown, expected: DiscardBinding): ConsumeResult {
  const state = typeof value === 'object' && value !== null ? minted.get(value) : undefined;
  if (!state) return 'invalid';
  if (state.spent) return 'spent';
  if (state.now() >= state.expiresAt) {
    state.spent = true; // an expired token is dead for good
    return 'expired';
  }
  const b = state.binding;
  if (b.workspaceId !== expected.workspaceId || b.op !== expected.op || b.fingerprint !== expected.fingerprint) {
    return 'mismatch';
  }
  state.spent = true;
  return 'ok';
}
