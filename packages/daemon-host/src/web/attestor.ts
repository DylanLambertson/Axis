// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { randomBytes } from "node:crypto";
import { AxisError } from "@axis/audit";
import type { Identity } from "@axis/daemon";
import { signAttestation } from "../control/attestation.js";
import type { Attestation } from "../control/messages.js";
import type { Clock } from "../ports/clock.js";

/**
 * The web host's attestation minting (`docs/design/web-host-entry.md` W-5): a private copy of the per-spawn key and one
 * fixed web identity per socket. Nothing a browser sends selects any field. `close()` zeroes the copy, after which
 * minting refuses (fails closed).
 */

export const WEB_WINDOW_ID = "web";
export const WEB_ACTOR_ID = "web-user";

export interface WebAttestor {
  mint(): Attestation;
  close(): void;
}

/** `copy` makes the private key copy (a seam for the test that proves `close()` zeroes it). */
export function createWebAttestor(key: Uint8Array, clock: Clock, copy: (k: Uint8Array) => Uint8Array = (k) => new Uint8Array(k)): WebAttestor {
  if (!(key instanceof Uint8Array) || key.length < 32) throw new AxisError("E_INVALID_ARGUMENT", "Invalid web host key", { reason: "web_key_invalid" });
  const own = copy(key);
  let closed = false;
  return {
    mint(): Attestation {
      if (closed) throw new AxisError("E_UNAVAILABLE", "The web host is stopped", { reason: "web_stopped" });
      const identity: Identity = {
        connectionId: randomBytes(18).toString("base64url"),
        windowId: WEB_WINDOW_ID,
        actorId: WEB_ACTOR_ID,
        actor: "user",
        trusted: false,
        clientKind: "web",
      };
      return signAttestation(own, identity, Math.floor(clock.now()));
    },
    close(): void {
      closed = true;
      own.fill(0);
    },
  };
}
