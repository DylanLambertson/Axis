// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

import { registerConfirmation, type DiscardBinding, type DiscardConfirmation } from './confirmation.js';

/**
 * Daemon-only entry point (package subpath `@axis/worktrees/daemon-confirm`).
 * Call it only after the challenge for exactly this workspace, operation and
 * `previewDiscard` fingerprint was approved with a native confirmation (B4).
 * It is deliberately not exported from the package root.
 */
export function markDiscardConfirmed(binding: DiscardBinding): DiscardConfirmation {
  return registerConfirmation(binding);
}

export type { DiscardBinding, DiscardConfirmation, DiscardOp } from './confirmation.js';
