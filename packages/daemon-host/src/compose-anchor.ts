// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { ControlClient } from "./control/client.js";

// The composition's own helper, kept out of the public index (moved out of compose.ts for its line budget).
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
