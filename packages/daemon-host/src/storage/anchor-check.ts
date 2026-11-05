// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { AuditLog, ChainHead } from "@axis/audit";

/**
 * Closed set of reasons the host starts degraded (design 3 step 6 and 5.5). They are the strings `ready.degraded`
 * carries to main, so they are reason codes, never text.
 */
export const DEGRADED_REASONS = [
  /** The chain ends before the supervisor's anchor: "the database is behind the anchor". Never reported as tampering. */
  "database_behind_anchor",
  /** The event at the anchor's sequence has another hash than the anchor. */
  "anchor_mismatch",
  /** The chain itself failed verification (an edited, reordered or missing row). */
  "audit_chain_invalid",
  /** The database has events but the supervisor holds no anchor. */
  "anchor_missing",
  /** The supervisor did not answer `anchor.get`, or the chain could not be read. */
  "anchor_unreachable",
] as const;
export type DegradedReason = (typeof DEGRADED_REASONS)[number];

export interface AnchorCheck {
  /** Set when the host must start degraded. */
  readonly degraded?: DegradedReason;
  /** The verified chain head (`null` for an empty chain); absent when the chain could not be verified. */
  readonly head?: ChainHead | null;
  /** The anchor the supervisor held, if any. */
  readonly anchor: ChainHead | null;
}

/**
 * Verify the whole chain against the supervisor's anchor (`docs/packages.md` "Audit anchor", requirements 1 and 3). The
 * full form is used on purpose: it is the startup check, so it re-reads every row. Reads only; it never appends, so a
 * broken or truncated chain is never extended by the check itself.
 *
 *  - first start (no events, no anchor): fine;
 *  - events but no anchor: degraded `anchor_missing`;
 *  - anchor but no events or a shorter chain: `database_behind_anchor`;
 *  - anything else that fails: `anchor_mismatch` or `audit_chain_invalid`;
 *  - the supervisor does not answer: `anchor_unreachable`, but only when there are events to protect.
 */
export async function checkAnchor(audit: AuditLog, getAnchor: () => Promise<ChainHead | null>): Promise<AnchorCheck> {
  let anchor: ChainHead | null;
  let reachable = true;
  try {
    anchor = await getAnchor();
  } catch {
    // A timeout and a closed channel both mean "no answer"; nothing the supervisor sent is kept.
    anchor = null;
    reachable = false;
  }
  let result: ReturnType<AuditLog["verify"]>;
  try {
    result = audit.verify(anchor === null ? {} : { expectedHead: anchor });
  } catch {
    return { degraded: "anchor_unreachable", anchor };
  }
  if (!result.ok) {
    if (result.reason === "truncated") return { degraded: "database_behind_anchor", anchor };
    if (result.reason === "hash_mismatch" && anchor !== null && result.firstBadSeq === anchor.seq && result.checked >= anchor.seq) {
      return { degraded: "anchor_mismatch", anchor };
    }
    return { degraded: "audit_chain_invalid", anchor };
  }
  if (anchor === null && result.head !== null) {
    return { degraded: reachable ? "anchor_missing" : "anchor_unreachable", head: result.head, anchor };
  }
  return { head: result.head, anchor };
}
