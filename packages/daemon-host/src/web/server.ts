// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { AxisError } from "@axis/audit";
import type { Clock } from "../ports/clock.js";
import type { ChannelFlow } from "../transport/node-ipc.js";
import type { ChannelMux } from "../transport/mux.js";
import { parseWebHostConfig, type WebHostConfig } from "./config.js";
import { SUBPROTOCOL, UPGRADE_REFUSALS, checkUpgrade, digestToken, type UpgradeRefusal } from "./handshake.js";
import { createWebAttestor } from "./attestor.js";
import { WebSession } from "./session.js";
import type { CloseCode } from "./ws-codec.js";

/**
 * The web host entry (ticket W1, `docs/design/web-host-entry.md`): the one file in the repository that may load a
 * listener module. It runs on the supervisor side of a daemon child (the web server), never in the daemon and never in
 * a desktop process (the import, staging and graph checks refuse every path to `src/web/` from the desktop entries).
 *
 * `startWebHost` parses the opt-in configuration (it refuses anything but `enabled: true` on a loopback literal),
 * listens, makes a per-start token, and for each upgrade that passes `checkUpgrade` opens one virtual connection of the
 * supervisor's mux, mints an attestation for it with the per-spawn key (actor `user`, client kind `web`, window `web`,
 * not trusted) and sends `connect { cid, attestation }`. The daemon verifies it like any other connection. Other HTTP
 * requests get 404. It owns no timer. Logging is closed event names and closed reasons only: never a header, the
 * token, the attestation or browser data.
 */

export { WEB_ACTOR_ID, WEB_WINDOW_ID } from "./attestor.js";
/** Raw sockets that may be mid-handshake at once; one more evicts the oldest, so held sockets cannot lock a client out. */
const PENDING_SOCKETS = 4;
const MAX_HEADER_BYTES = 8_192;
/** Node's own deadlines for a request's headers and the whole request, and how often it checks them (ms). */
const HEADERS_TIMEOUT_MS = 5_000;
const CHECK_INTERVAL_MS = 1_000;

export type WebHostEvent = "web.listening" | "web.refused" | "web.opened" | "web.closed" | "web.paused" | "web.resumed" | "web.stopped";
export type WebRefusal = UpgradeRefusal | "too_many_clients" | "unavailable" | "mux_refused" | "not_upgrade" | "pending_evicted";

export interface WebHostOptions {
  /** Raw configuration; parsed here with `parseWebHostConfig`, so an unparsed object cannot start a listener. */
  readonly config: unknown;
  /** The supervisor's side of the daemon's control channel. */
  readonly mux: ChannelMux;
  /** The backlog of the channel under `mux`. */
  readonly flow: ChannelFlow;
  /** The per-spawn attestation key the supervisor sent in `init` (copied; zeroed by `dispose`). */
  readonly attestationKey: Uint8Array;
  readonly clock: Clock;
  /** Makes the private key copy (default: a new `Uint8Array`). A test seam only: `dispose()` zeroes what it returns. */
  readonly keyCopy?: (key: Uint8Array) => Uint8Array;
  /** Closed event names and closed details only. */
  readonly log?: (event: WebHostEvent, detail?: { readonly reason?: WebRefusal; readonly code?: CloseCode }) => void;
}

export interface WebHostStats {
  readonly sessions: number;
  /** Sockets that have not upgraded yet. */
  readonly pendingSockets: number;
  readonly opened: number;
  readonly paused: boolean;
  readonly refused: Readonly<Record<WebRefusal, number>>;
  readonly closed: Readonly<Record<string, number>>;
}

export interface WebHost {
  readonly address: { readonly host: string; readonly port: number };
  /** The per-start token, once; a second call throws `E_CONFLICT`. The caller hands it to the browser. */
  takeToken(): string;
  stats(): WebHostStats;
  /** Stop listening, close every session (1001) and zero the key copy. Resolves when the server has closed. */
  dispose(): Promise<void>;
}

const STATUS_TEXT: Readonly<Record<number, string>> = { 400: "Bad Request", 403: "Forbidden", 404: "Not Found", 426: "Upgrade Required", 503: "Service Unavailable" };

const ignore = (): void => undefined;

/** True when `server.address()` is the configured loopback literal on a TCP port (W-1: checked after every listen). */
export function isBoundTo(bound: AddressInfo | string | null, host: string): bound is AddressInfo {
  return bound !== null && typeof bound === "object" && bound.address === host && Number.isInteger(bound.port) && bound.port > 0;
}

function refuseSocket(socket: Socket, status: number): void {
  try {
    socket.end(`HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? "Error"}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => void socket.destroy());
  } catch {
    socket.destroy();
  }
}

export async function startWebHost(options: WebHostOptions): Promise<WebHost> {
  const config: WebHostConfig = parseWebHostConfig(options.config);
  const { mux, flow, clock } = options;
  const attestor = createWebAttestor(options.attestationKey, clock, options.keyCopy);
  const log = options.log ?? ((): void => undefined);
  const limits = config.limits;
  const origins = new Set(config.allowedOrigins);
  let token: string | undefined = randomBytes(32).toString("base64url");
  const tokenDigest = digestToken(token);
  const sessions = new Set<WebSession>();
  const refused = Object.fromEntries([...UPGRADE_REFUSALS, "too_many_clients", "unavailable", "mux_refused", "not_upgrade", "pending_evicted"].map((r) => [r, 0])) as Record<WebRefusal, number>;
  const closed: Record<string, number> = {};
  let opened = 0;
  let paused = false;
  let stopped = false;
  let channelClosed = false;
  let port = 0;

  const refuse = (socket: Socket, status: number, reason: WebRefusal): void => {
    refused[reason]++;
    log("web.refused", { reason });
    refuseSocket(socket, status);
  };

  const checkBacklog = (): void => {
    if (paused || flow.pending() < limits.maxChannelBacklog) return;
    paused = true;
    log("web.paused");
    for (const s of sessions) s.pause();
  };
  const unsubscribeDrain = flow.onDrain(() => {
    if (!paused) return;
    paused = false;
    log("web.resumed");
    for (const s of [...sessions]) {
      // A session replaying its held frames can fill the backlog again: then the rest stay paused.
      if (paused) break;
      s.resume();
    }
  });

  const closeAll = (code: CloseCode): void => {
    for (const s of [...sessions]) s.close(code);
  };
  const unsubscribeChannel = mux.onChannelClose(() => {
    channelClosed = true;
    closeAll(1001);
  });

  /** Sockets that have not upgraded yet, oldest first. */
  const pending = new Set<Socket>();
  const onConnection = (socket: Socket): void => {
    // Kept for the socket's whole life: a write to a socket the peer reset (a refusal, a close frame) reports its
    // error asynchronously, and an unhandled one would end the web server process.
    socket.on("error", ignore);
    pending.add(socket);
    socket.once("close", () => void pending.delete(socket));
    if (pending.size > PENDING_SOCKETS) {
      const oldest = pending.values().next().value as Socket;
      pending.delete(oldest);
      refused.pending_evicted++;
      log("web.refused", { reason: "pending_evicted" });
      oldest.destroy();
    }
  };

  const onUpgrade = (req: IncomingMessage, socket: Socket, head: Buffer): void => {
    pending.delete(socket);
    if (stopped || channelClosed) return refuse(socket, 503, "unavailable");
    if (sessions.size >= limits.maxClients) return refuse(socket, 503, "too_many_clients");
    const check = checkUpgrade(req, { host: config.host, port, allowedOrigins: origins, tokenDigest });
    if (!check.ok) return refuse(socket, check.status, check.reason);
    const cid = randomBytes(16).toString("base64url");
    const connection = mux.open(cid);
    if (connection === undefined) return refuse(socket, 503, "mux_refused");
    try {
      mux.sendControl({ type: "connect", cid, attestation: attestor.mint() });
    } catch {
      connection.close();
      return refuse(socket, 503, "unavailable");
    }
    socket.setNoDelay(true);
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${check.accept}\r\nSec-WebSocket-Protocol: ${SUBPROTOCOL}\r\n\r\n`);
    const session = new WebSession({
      socket,
      connection,
      maxFrameBytes: limits.maxFrameBytes,
      maxOutboundBytes: limits.maxOutboundBytes,
      forwarded: checkBacklog,
      ended: (code) => {
        sessions.delete(session);
        closed[String(code)] = (closed[String(code)] ?? 0) + 1;
        log("web.closed", { code });
      },
    });
    sessions.add(session);
    opened++;
    log("web.opened");
    session.start(head, paused);
  };

  const onRequest = (_req: IncomingMessage, res: ServerResponse): void => {
    refused.not_upgrade++;
    res.writeHead(404, { Connection: "close", "Content-Length": "0" });
    res.end();
  };

  const server = createServer({
    maxHeaderSize: MAX_HEADER_BYTES,
    requireHostHeader: true,
    headersTimeout: HEADERS_TIMEOUT_MS,
    requestTimeout: HEADERS_TIMEOUT_MS,
    connectionsCheckingInterval: CHECK_INTERVAL_MS,
  });
  // One above sessions plus pending, so a new socket is always accepted and can evict the oldest pending one.
  server.maxConnections = limits.maxClients + PENDING_SOCKETS + 1;
  server.on("connection", onConnection);
  server.on("upgrade", onUpgrade);
  server.on("request", onRequest);
  server.on("clientError", (_e: Error, socket: Socket) => void socket.destroy());

  const release = (): void => {
    unsubscribeDrain();
    unsubscribeChannel();
    attestor.close();
    token = undefined;
  };

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host: config.host, port: config.port, exclusive: true, ipv6Only: config.host === "::1" }, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch {
    release();
    throw new AxisError("E_UNAVAILABLE", "The web host could not listen", { reason: "listen_failed" });
  }
  const bound = server.address();
  if (!isBoundTo(bound, config.host)) {
    release();
    await new Promise<void>((r) => server.close(() => r()));
    throw new AxisError("E_UNAVAILABLE", "The web host bound an unexpected address", { reason: "bind_mismatch" });
  }
  port = (bound as AddressInfo).port;
  server.on("error", () => undefined);
  log("web.listening");

  let disposing: Promise<void> | undefined;
  return {
    address: Object.freeze({ host: config.host, port }),
    takeToken(): string {
      if (token === undefined) throw new AxisError("E_CONFLICT", "The web host token was already taken", { reason: "token_taken" });
      const t = token;
      token = undefined;
      return t;
    },
    stats: () => Object.freeze({ sessions: sessions.size, pendingSockets: pending.size, opened, paused, refused: Object.freeze({ ...refused }), closed: Object.freeze({ ...closed }) }),
    dispose(): Promise<void> {
      if (disposing !== undefined) return disposing;
      stopped = true;
      disposing = new Promise<void>((resolve) => {
        server.close(() => resolve());
        closeAll(1001);
        server.closeAllConnections();
        release();
        log("web.stopped");
      });
      return disposing;
    },
  };
}
