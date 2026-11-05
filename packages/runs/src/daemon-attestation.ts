// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Subpath `@axis/runs/daemon-attestation`. Only the daemon's connection layer may import this
// (enforced by test/packages/imports.test.mjs); it is not part of the package root.
import { AxisError } from "@axis/audit";
import { mintTrustAttestation, type TrustAttestation, type AttestationFacts } from "./attestation.js";

export type { TrustAttestation };

/**
 * Mint a trust attestation. Call it only where main has attested, on the window-verified run-start call, that the
 * source repository of this workspace is trusted now. Never derive it from a request payload or a renderer claim.
 * `issuedAt` is the supervisor's clock reading at that moment (`Clock.now()`).
 */
export function attestTrust(facts: AttestationFacts): TrustAttestation {
  const ok = (s: unknown): s is string => typeof s === "string" && s.length > 0 && s.length <= 128;
  if (typeof facts !== "object" || facts === null || !ok(facts.workspaceId) || !ok(facts.projectId) || !Number.isFinite(facts.issuedAt)) {
    throw new AxisError("E_INVALID_ARGUMENT", "Invalid trust attestation");
  }
  return mintTrustAttestation({ workspaceId: facts.workspaceId, projectId: facts.projectId, issuedAt: facts.issuedAt });
}
