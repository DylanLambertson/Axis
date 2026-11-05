// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { fromElectronPort, type Connection, type ElectronPortLike } from "@axis/daemon";
import type { Logger } from "../log/logger.js";
import type { ChannelMux } from "../transport/mux.js";
import type { ConnectLimiter } from "./connect-limiter.js";
import { refuseNonPlainData } from "../inspect.js";
import { connectMessageSchema, type Attestation } from "./messages.js";

/**
 * Turns a `connect` control message into a `Connection` for `daemon.accept(connection, attestation)`: a virtual
 * connection of the mux (child process and web hosts) or a transferred port (Electron). The connect limiter runs
 * first. Over the limit the connection is closed with no `hello-rejected`, which would be a reconnect oracle. The
 * attestation is not checked here: that is the verifier's job inside `accept`, and the window id used for the limit
 * is only a bucket name, so a forged one can only share or burn a bucket, never gain access. Accepted: a writer of
 * the control channel without the key can fill the bucket table with window ids and make new windows wait about a
 * refill period; that writer can already send `shutdown`, and the web host (W1) must keep it in mind.
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
  /**
   * The entry point for a message that arrived with a transferred port: the data must be plain and a `connect`
   * message without a `cid`. Anything else closes the port. Never throws.
   */
  fromPortMessage(data: unknown, port: ElectronPortLike): void;
  /** Port messages refused because the data was not a valid `connect`. */
  readonly refusedPortMessages: () => number;
}

function windowOf(attestation: Attestation): string {
  const w = attestation.identity["windowId"];
  return typeof w === "string" && WINDOW_ID.test(w) ? w : UNKNOWN_WINDOW;
}

export function createConnectRouter(options: ConnectRouterOptions): ConnectRouter {
  const { limiter, accept, mux, logger } = options;

  let refusedPortMessages = 0;
  const closePort = (port: ElectronPortLike): void => {
    try {
      port.close();
    } catch {
      // Already closed.
    }
  };

  const hand = (connection: Connection, attestation: Attestation): void => {
    try {
      accept(connection, attestation);
    } catch {
      // Whatever the accept callback does, a connection it did not take must not stay open.
      connection.close();
      logger?.warn("connection.rejected", { reason: "accept_failed" });
    }
  };

  const fromPort = (request: { attestation: Attestation }, port: ElectronPortLike): void => {
    if (!limiter.tryAcquire(windowOf(request.attestation))) {
      closePort(port);
      logger?.warn("connection.rejected", { reason: "rate_limited" });
      return;
    }
    hand(fromElectronPort(port), request.attestation);
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

    fromPort,

    fromPortMessage(data, port): void {
      try {
        const parsed = refuseNonPlainData(data) === undefined ? connectMessageSchema.safeParse(data) : undefined;
        if (parsed === undefined || !parsed.success || parsed.data.cid !== undefined) {
          refusedPortMessages++;
          closePort(port);
          logger?.warn("connection.rejected", { reason: "bad_port_message" });
          return;
        }
        fromPort({ attestation: parsed.data.attestation }, port);
      } catch {
        // Defensive: nothing above is expected to throw, but this entry point must never throw into the adapter.
        refusedPortMessages++;
        closePort(port);
      }
    },
    refusedPortMessages: () => refusedPortMessages,
  };
}
