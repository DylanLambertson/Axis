// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { fromElectronPort, type Connection, type ElectronPortLike } from "@axis/daemon";
import type { Logger } from "../log/logger.js";
import type { ChannelMux } from "../transport/mux.js";
import type { ConnectLimiter } from "./connect-limiter.js";
import type { Attestation } from "./messages.js";

/**
 * Turns a `connect` control message into a `Connection` for `daemon.accept(connection, attestation)`: a virtual
 * connection of the mux (child process and web hosts) or a transferred port (Electron). The connect limiter runs
 * first. Over the limit the connection is closed with no `hello-rejected`, which would be a reconnect oracle. The
 * attestation is not checked here: that is the verifier's job inside `accept`, and the window id used for the limit
 * is only a bucket name, so a forged one can only share or burn a bucket, never gain access.
 */

const WINDOW_ID = /^[A-Za-z0-9._:-]{1,64}$/;
/** The bucket for attestations whose window id is not even well formed. */
const UNKNOWN_WINDOW = "?";

export type AcceptConnection = (connection: Connection, attestation: Attestation) => void;

export interface ConnectRouterOptions {
  readonly limiter: ConnectLimiter;
  readonly accept: AcceptConnection;
  readonly mux?: ChannelMux;
  readonly logger?: Logger;
}

export interface ConnectRouter {
  /** A `connect` that names a mux connection id. */
  fromMux(request: { cid?: string; attestation: Attestation }): void;
  /** A `connect` that arrived with a transferred port. */
  fromPort(request: { attestation: Attestation }, port: ElectronPortLike): void;
}

function windowOf(attestation: Attestation): string {
  const w = attestation.identity["windowId"];
  return typeof w === "string" && WINDOW_ID.test(w) ? w : UNKNOWN_WINDOW;
}

export function createConnectRouter(options: ConnectRouterOptions): ConnectRouter {
  const { limiter, accept, mux, logger } = options;

  const hand = (connection: Connection, attestation: Attestation): void => {
    try {
      accept(connection, attestation);
    } catch {
      // Whatever the accept callback does, a connection it did not take must not stay open.
      connection.close();
      logger?.warn("connection.rejected", { reason: "accept_failed" });
    }
  };

  return {
    fromMux(request): void {
      if (mux === undefined || request.cid === undefined) {
        logger?.warn("connection.rejected", { reason: "no_cid" });
        return;
      }
      const connection = mux.open(request.cid);
      if (connection === undefined) {
        logger?.warn("connection.rejected", { reason: "mux_refused" });
        return;
      }
      if (!limiter.tryAcquire(windowOf(request.attestation))) {
        connection.close();
        logger?.warn("connection.rejected", { reason: "rate_limited" });
        return;
      }
      hand(connection, request.attestation);
    },

    fromPort(request, port): void {
      if (!limiter.tryAcquire(windowOf(request.attestation))) {
        try {
          port.close();
        } catch {
          // Already closed.
        }
        logger?.warn("connection.rejected", { reason: "rate_limited" });
        return;
      }
      hand(fromElectronPort(port), request.attestation);
    },
  };
}
