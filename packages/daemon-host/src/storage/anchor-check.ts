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
  /** The supervisor did not answer `anchor.get` (no answer is never read as "no anchor", whatever the chain holds). */
  "anchor_unreachable",
  /** The chain could not be read at all (a storage error while verifying). */
  "audit_unreadable",
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
 *  - first start: the supervisor ANSWERED "no anchor" and there are no events. Only an explicit answer counts;
 *    a timeout, a closed channel or an error is `anchor_unreachable` whatever the chain holds, because an attacker
 *    who deleted the database and a slow supervisor would otherwise look like a first start and the host would then
 *    replace the supervisor's real anchor with a lower one;
 *  - events but no anchor: degraded `anchor_missing`;
 *  - anchor but no events or a shorter chain: `database_behind_anchor`;
 *  - anything else that fails: `anchor_mismatch` or `audit_chain_invalid`;
 *  - the chain cannot be read: `audit_unreadable`.
 */
export async function checkAnchor(audit: AuditLog, getAnchor: () => Promise<ChainHead | null>): Promise<AnchorCheck> {
  let anchor: ChainHead | null;
  try {
    anchor = await getAnchor();
  } catch {
    // A timeout and a closed channel both mean "no answer"; nothing the supervisor sent is kept. A late answer is
    // ignored by the control client, so the host stays degraded and never replaces the stored anchor.
    return { degraded: "anchor_unreachable", anchor: null };
  }
  let result: ReturnType<AuditLog["verify"]>;
  try {
    result = audit.verify(anchor === null ? {} : { expectedHead: anchor });
  } catch {
    return { degraded: "audit_unreadable", anchor };
  }
  if (!result.ok) {
    if (result.reason === "truncated") return { degraded: "database_behind_anchor", anchor };
    if (result.reason === "hash_mismatch" && anchor !== null && result.firstBadSeq === anchor.seq) {
      return { degraded: "anchor_mismatch", anchor };
    }
    return { degraded: "audit_chain_invalid", anchor };
  }
  if (anchor === null && result.head !== null) return { degraded: "anchor_missing", head: result.head, anchor };
  return { head: result.head, anchor };
}
