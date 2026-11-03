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
  spent: boolean;
}

const minted = new WeakMap<object, State>();

/** Internal: used by `daemonConfirm.ts`, which is the only minting entry point. */
export function registerConfirmation(binding: DiscardBinding): DiscardConfirmation {
  const token = Object.freeze({}) as DiscardConfirmation;
  minted.set(token, { binding: { ...binding }, spent: false });
  return token;
}

export type ConsumeResult = 'ok' | 'invalid' | 'mismatch' | 'spent';

/** Checks the binding and marks the token used when it matches. */
export function consumeConfirmation(value: unknown, expected: DiscardBinding): ConsumeResult {
  const state = typeof value === 'object' && value !== null ? minted.get(value) : undefined;
  if (!state) return 'invalid';
  if (state.spent) return 'spent';
  const b = state.binding;
  if (b.workspaceId !== expected.workspaceId || b.op !== expected.op || b.fingerprint !== expected.fingerprint) {
    return 'mismatch';
  }
  state.spent = true;
  return 'ok';
}
