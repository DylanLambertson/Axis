// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { attestTrust } from "@axis/runs/daemon-attestation";
import type { Clock } from "../ports/clock.js";
import type { RunTrustAttestation, RunTrustMinter } from "../ports/runs.js";
import { runFailure } from "../runs/errors.js";

/**
 * The one file that mints the single-use `TrustAttestation` (design section 6.2, TRU-2). A minter is made from the host's
 * clock and nothing else; `attest` is called by the `axis.cli-runs/1.start` handler only after main answered `trust.check`
 * with `trusted: true` for this connection's window, workspace and the journal's project, and the result goes straight to
 * `start`: never stored, logged or reused (the attestation is spent by the supervisor and expires on its own). The ids come
 * from the journal row and the attested connection, never from a payload. A malformed fact is refused here with a fixed
 * error instead of reaching the package.
 */
export function createRunTrustMinter(clock: Pick<Clock, "now">): RunTrustMinter {
  return {
    attest(facts: { readonly workspaceId: string; readonly projectId: string }): RunTrustAttestation {
      try {
        const issuedAt = clock.now();
        return attestTrust({ workspaceId: facts.workspaceId, projectId: facts.projectId, issuedAt }) as unknown as RunTrustAttestation;
      } catch {
        throw runFailure("E_INTERNAL");
      }
    },
  };
}
