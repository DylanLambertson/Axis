// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { z } from "zod";
import type { AuditSink } from "@axis/audit";
import { MAX_CARD_TAINT_SOURCES, taintReceiptSchema, type ApprovalTaint, type TaintReceipt } from "@axis/protocol";

/**
 * The taint rule IAC-T (docs/design/inter-agent-communication.md sections 6.5 and 6.6, ticket PV-M0): one sticky,
 * daemon-held flag per composer run.
 *
 * - **Set before the content reaches the model.** A producer of a listed source calls `receive` BEFORE it returns the tool
 *   result or the delivery that carries the content, so the next call of the same model reply is already decided under
 *   the flag. The flag is set first of all, before the input is even checked: an input that is not a receipt of the
 *   closed list, or an audit row that cannot be written, still leaves the run tainted, and `receive` then throws so the
 *   producer withholds the content (fail closed).
 * - **Sticky, also across a restart or a resume (review pv-m0 S2).** Nothing clears it: there is no method that does. It
 *   is recorded in the journal (`composer_runs.tainted`, schema version 8, only ever set) right after the in-memory flag,
 *   before anything else, and a `RunTaint` for a run starts from what the journal recorded. A journal that cannot be read
 *   starts it tainted; a record that cannot be written throws, so the producer withholds the content.
 * - **The decision hook.** `decide` is the broker's `DecisionHook`, asked for every call: while the flag is set, every call
 *   above `read` (section 6.5: everything but pure reads) needs the user's approval, whatever the floor or any standing
 *   allow says; the broker records the decision's tier and the `taint` reason at that moment.
 * - **The card.** `card()` lists the most recent sources (bounded) and how many there were in all, for the approval card.
 * - **Audit.** One `message.taint` row per receipt: the run, the source type, the source id and the hop, never the content.
 *
 * Producers: the message delivery into runs (PV-M3 slice 2, `messages/delivery.ts`) for source 1; PV-M4 (2 and 3), PV-Q1 (4),
 * PV-T1 (5 and 8), PV-K4 (6) and PV-N1 (7) call `receive` the same way.
 */

export const TAINT_AUDIT_ACTION = "message.taint";

/** `message.taint` keys kept by the host's audit log (section 8.1). */
export const TAINT_PAYLOAD_ALLOWLIST: Readonly<Record<string, readonly string[]>> = Object.freeze({
  [TAINT_AUDIT_ACTION]: Object.freeze(["runId", "source", "sourceId", "senderKind", "hop"]),
});

/** What a producer hands over: a receipt of the closed list, without the time (the daemon stamps it). */
export const taintInputSchema = taintReceiptSchema.omit({ at: true });
export type TaintInput = z.infer<typeof taintInputSchema>;

/** The reason the broker records with a decision that IAC-T raised. */
export const TAINT_REASON = "taint";

export interface RunTaint {
  /** Taint the run (first, always), then check, record and audit the receipt. Throws for a bad receipt or a failed audit row. */
  receive(input: unknown): void;
  tainted(): boolean;
  /** The approval card's list, or undefined while the run is untainted. A copy. */
  card(): ApprovalTaint | undefined;
  /** The broker's decision hook: raise every call above `read` to approval while the flag is set. */
  decide(call: { readonly tool: string; readonly tier: string }): { readonly approve: boolean; readonly reasons: readonly string[] };
}

/** Where a run's taint is recorded (the journal's composer records). */
export interface TaintStore {
  tainted(runId: string): boolean;
  /** Throws when the taint cannot be recorded (for example a run with no composer record). */
  markTainted(runId: string): void;
}

export interface RunTaintDeps {
  readonly runId: string;
  readonly store: TaintStore;
  readonly audit: AuditSink;
  readonly now: () => number;
  /** Sources kept for the card. Default `MAX_CARD_TAINT_SOURCES`. */
  readonly keep?: number;
}

export function createRunTaint(deps: RunTaintDeps): RunTaint {
  const keep = deps.keep ?? MAX_CARD_TAINT_SOURCES;
  if (!Number.isSafeInteger(keep) || keep < 1 || keep > MAX_CARD_TAINT_SOURCES) throw new RangeError("taint card size is out of range");
  // Fail closed: a run whose record cannot be read is treated as tainted.
  let earlier: boolean;
  try {
    earlier = deps.store.tainted(deps.runId) === true;
  } catch {
    earlier = true;
  }
  let flag = earlier;
  let total = 0;
  const recent: TaintReceipt[] = [];

  return {
    receive(input) {
      // First: whatever follows (a bad receipt, a failed audit row), the run is tainted from here on.
      flag = true;
      total += 1;
      // Recorded before the content can reach the model, so a resumed or restarted run starts tainted.
      deps.store.markTainted(deps.runId);
      const parsed = taintInputSchema.safeParse(input);
      if (!parsed.success) throw new TypeError("not a taint receipt of the closed source list");
      const at = Math.max(0, Math.floor(deps.now()));
      const receipt = taintReceiptSchema.parse({ ...parsed.data, at });
      recent.push(receipt);
      if (recent.length > keep) recent.shift();
      deps.audit.append({
        actor: "daemon",
        action: TAINT_AUDIT_ACTION,
        target: `run:${deps.runId}`,
        outcome: "success",
        payload: { runId: deps.runId, source: receipt.source, sourceId: receipt.ref, senderKind: receipt.senderKind, hop: receipt.hop },
      });
    },
    tainted: () => flag,
    // A tainted run always has a card: its sources, the count of every receipt (a malformed one included), or `earlier`.
    card: () => (flag ? { sources: recent.map((r) => ({ ...r })), total, earlier } : undefined),
    decide: ({ tier }) => (flag && tier !== "read" ? { approve: true, reasons: [TAINT_REASON] } : { approve: false, reasons: [] }),
  };
}
