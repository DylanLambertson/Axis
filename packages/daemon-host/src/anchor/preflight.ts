// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { AnchorGuard } from "./manager.js";

/**
 * The anchor check for the approval gate (design 5.4, ticket H5's `preflight` seam). The gate calls it with the final
 * tier before it issues a challenge and before it spends an approval, so a stalled host refuses with the closed
 * `E_UNAVAILABLE` (`details.reason: "anchor_stalled"`) without asking the user or burning anything. It is the same
 * check, and throws the same `DaemonError`, as the in-handler guard that stays behind it as defence in depth.
 * Synchronous on purpose: the gate refuses an async preflight.
 */
export function anchorPreflight(anchors: Pick<AnchorGuard, "check">): (tier: number) => void {
  return (tier) => {
    anchors.check(tier);
  };
}

/** Payload keys of the rows the anchor manager writes: one fixed literal each, never text from a caller. */
export const ANCHOR_PAYLOAD_ALLOWLIST: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "anchor.stalled": Object.freeze(["reason"]),
  "anchor.resumed": Object.freeze(["code"]),
});
