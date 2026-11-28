// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { AxisError } from "@axis/audit";
import type { ControlClient } from "./control/client.js";

// The composition's own shutdown step 4, kept out of the public index (moved out of compose.ts for its line budget).

/**
 * The final put must cover the newest row (one that could not be sent, a closed channel, leaves rows unanchored: thrown), and
 * its acknowledgement is awaited for `waitMs`; none in time throws (the anchor on the supervisor is older than the database).
 */
export async function confirmFinalAnchor(
  control: Pick<ControlClient, "onAnchorAck">,
  state: { anchor(): { readonly put?: { readonly seq: number } | null | undefined; readonly ackedSeq: number }; head(): { readonly seq: number } | null },
  waitMs: number,
): Promise<void> {
  const target = state.anchor().put;
  const head = state.head();
  if (head !== null && (target === undefined || target === null || target.seq < head.seq) && state.anchor().ackedSeq < head.seq) {
    throw new AxisError("E_UNAVAILABLE", "The final audit anchor could not be sent", { reason: "final_anchor_unsent" });
  }
  if (target === undefined || target === null || state.anchor().ackedSeq >= target.seq) return;
  const acked = await awaitAnchorAck(control, () => state.anchor().ackedSeq >= target.seq, waitMs);
  if (!acked) throw new AxisError("E_UNAVAILABLE", "The final audit anchor was not acknowledged", { reason: "final_anchor_unacked" });
}

/** Wait until `acked()` holds after an `anchor.ack`, or `ms` pass: true when it held in time (shutdown step 4). */
export function awaitAnchorAck(control: Pick<ControlClient, "onAnchorAck">, acked: () => boolean, ms: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const off = control.onAnchorAck(() => {
      if (acked()) done(true);
    });
    const timer = setTimeout(() => done(false), ms) as unknown as NodeJS.Timeout; // opaque handle under Code OSS's typings (ADR 0005)
    timer.unref();
    function done(ok: boolean): void {
      clearTimeout(timer);
      off?.();
      resolve(ok);
    }
  });
}
