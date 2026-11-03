// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

import { registerConfirmation, type ConfirmationOptions, type DiscardBinding, type DiscardConfirmation } from './confirmation.js';

/**
 * Daemon-only entry point (package subpath `@axis/worktrees/daemon-confirm`).
 * Call it only after the challenge for exactly this workspace, operation and
 * `previewDiscard` fingerprint was approved with a native confirmation (B4).
 * The token expires after 30 s on a monotonic clock and is spent by the first
 * finalise or remove that accepts it, even if that operation then fails.
 * It is deliberately not exported from the package root.
 */
export function markDiscardConfirmed(binding: DiscardBinding, opts?: ConfirmationOptions): DiscardConfirmation {
  return registerConfirmation(binding, opts);
}

export { CONFIRMATION_TTL_MS, type ConfirmationOptions } from './confirmation.js';
export type { DiscardBinding, DiscardConfirmation, DiscardOp } from './confirmation.js';
