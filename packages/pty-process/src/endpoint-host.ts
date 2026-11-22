// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { lstatSync, mkdirSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { ENDPOINT_ID, RELAY_FRAME_CHARS, type RelayInbound, type RelayOutbound } from "./messages.js";
import type { Clock } from "./ports.js";

/**
 * The CLI messaging endpoint's listener, hosted by the pty process (ticket PV-M6 slice 2; ADR 0007 decisions 7.1 to 7.4;
 * docs/design/inter-agent-cli-endpoint.md sections 2 and 3). It owns the transport only: the socket in the user's runtime
 * directory, the connection and frame bounds, and relaying each complete frame to the daemon as its JSON text. The daemon owns
 * the token, the caller, the message service and every answer; this module never reads a frame's content.
 *
 * - **The directory is the control (Unix).** A real directory, owned by this uid, mode 0700, never a symlink; created 0700 when
 *   absent, refused otherwise. Peer credentials are not checked: Node exposes none (`SO_PEERCRED`, `getpeereid`), and the ADR ships
 *   Unix without a native helper, so the 0700 directory is what keeps other users out. Windows has no endpoint (no pipe helper).
 * - **Bounds (7.4).** At most 4 connections per endpoint (the fifth is closed at accept); 4-byte big-endian length framing; the
 *   first frame (the `auth`) at most 512 bytes and within 2 s, and nothing more until the daemon answered it; later frames at most
 *   64 KiB, at most 4 awaiting an answer; a frame that is not UTF-8 or over its cap closes the connection; an authenticated
 *   connection idle for 10 minutes is closed. Every buffer is bounded by those caps.
 * - **Backoff.** The daemon marks a token failure (`authFailed`) and closes that connection. Per-peer backoff needs a peer id that
 *   Node does not give, so the bound is one `auth` per connection under the 4-connection cap (the design's stated residual).
 */

export const ENDPOINT_HOST_LIMITS = Object.freeze({ connections: 4, authFrameBytes: 512, frameBytes: 64 * 1024, preAuthMs: 2_000, idleMs: 600_000, pendingFrames: 4, pathBytes: 100 });

export interface EndpointHostConfig {
  /** The runtime directory: `$XDG_RUNTIME_DIR/axis`, else `/tmp/axis-<uid>` on Linux; `$TMPDIR/axis` on macOS (`defaultEndpointDir`). */
  readonly dir: string;
  readonly platform: NodeJS.Platform;
  /** This process's uid (the directory's required owner). */
  readonly uid: number;
}

export interface EndpointHost {
  /** Listen for one run's endpoint; the socket path, or undefined when no endpoint can be made (then nothing is listening). */
  open(endpoint: string): Promise<string | undefined>;
  /** Close an endpoint: every connection, the listener and its socket file (run end, or the daemon's `endpoint-close`). */
  close(endpoint: string): void;
  /** A daemon message for the relay. */
  onRelay(msg: RelayOutbound): void;
  closeAll(): void;
}

/** The default runtime directory for this platform and environment, or undefined where none is defined (Windows). */
export function defaultEndpointDir(env: Readonly<Record<string, string | undefined>>, platform: NodeJS.Platform, uid: number): string | undefined {
  if (platform === "win32") return undefined;
  if (platform === "darwin") return env["TMPDIR"] === undefined || env["TMPDIR"] === "" ? undefined : join(env["TMPDIR"], "axis");
  const xdg = env["XDG_RUNTIME_DIR"];
  return xdg !== undefined && xdg.startsWith("/") ? join(xdg, "axis") : `/tmp/axis-${uid}`;
}

/** True when `dir` is (or was just made) a real directory owned by `uid` with mode 0700. */
export function endpointDirOk(dir: string, uid: number): boolean {
  try {
    let st;
    try {
      st = lstatSync(dir);
    } catch {
      mkdirSync(dir, { mode: 0o700 });
      st = lstatSync(dir);
    }
    return st.isDirectory() && !st.isSymbolicLink() && st.uid === uid && (st.mode & 0o777) === 0o700;
  } catch {
    return false;
  }
}

interface Conn {
  readonly id: string;
  readonly sock: Socket;
  buf: Buffer;
  /** The `auth` was relayed and not yet answered / it was answered without a close. */
  state: "new" | "authing" | "authed";
  pending: number;
  timer: unknown;
}
interface Hosted {
  readonly server: Server;
  readonly path: string;
  readonly conns: Map<string, Conn>;
}

export function createEndpointHost(cfg: EndpointHostConfig, deps: { readonly send: (msg: RelayInbound) => boolean; readonly clock: Clock; readonly random: (n: number) => Uint8Array }): EndpointHost {
  const hosted = new Map<string, Hosted>();
  let seq = 0;

  const drop = (endpoint: string, c: Conn): void => {
    const h = hosted.get(endpoint);
    if (h === undefined || h.conns.get(c.id) !== c) return;
    h.conns.delete(c.id);
    deps.clock.clearTimeout(c.timer);
    c.sock.destroy();
    deps.send({ t: "relay-close", endpoint, conn: c.id });
  };
  const arm = (endpoint: string, c: Conn, ms: number): void => {
    deps.clock.clearTimeout(c.timer);
    c.timer = deps.clock.setTimeout(() => drop(endpoint, c), ms);
  };

  /** Take every complete frame out of the connection's buffer; a frame over its cap, or not UTF-8, closes the connection. */
  function frames(endpoint: string, c: Conn): void {
    for (;;) {
      const cap = c.state === "authed" ? ENDPOINT_HOST_LIMITS.frameBytes : ENDPOINT_HOST_LIMITS.authFrameBytes;
      // Nothing after the `auth` is relayed before the daemon answered it; it waits, bounded by the auth cap (see `accept`).
      if (c.buf.length < 4 || c.state === "authing") return;
      const len = c.buf.readUInt32BE(0);
      if (len > cap) return drop(endpoint, c);
      if (c.buf.length < 4 + len) return;
      const bytes = c.buf.subarray(4, 4 + len);
      c.buf = Buffer.from(c.buf.subarray(4 + len));
      let frame: string;
      try {
        frame = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        return drop(endpoint, c);
      }
      if (frame.length > RELAY_FRAME_CHARS || c.pending >= ENDPOINT_HOST_LIMITS.pendingFrames) return drop(endpoint, c);
      c.pending += 1;
      if (c.state === "new") c.state = "authing";
      else arm(endpoint, c, ENDPOINT_HOST_LIMITS.idleMs);
      if (!deps.send({ t: "relay-frame", endpoint, conn: c.id, frame })) return drop(endpoint, c);
    }
  }

  function accept(endpoint: string, h: Hosted, sock: Socket): void {
    if (h.conns.size >= ENDPOINT_HOST_LIMITS.connections) return void sock.destroy();
    const c: Conn = { id: `c${(seq++).toString(36)}`, sock, buf: Buffer.alloc(0), state: "new", pending: 0, timer: undefined };
    h.conns.set(c.id, c);
    arm(endpoint, c, ENDPOINT_HOST_LIMITS.preAuthMs);
    if (!deps.send({ t: "relay-open", endpoint, conn: c.id })) return drop(endpoint, c);
    sock.on("data", (chunk: Buffer) => {
      // Bounded: one frame's cap plus its prefix is all a connection may hold unanswered.
      const cap = 4 + (c.state === "authed" ? ENDPOINT_HOST_LIMITS.frameBytes : ENDPOINT_HOST_LIMITS.authFrameBytes);
      if (c.buf.length + chunk.length > cap) return drop(endpoint, c);
      c.buf = Buffer.concat([c.buf, chunk]);
      frames(endpoint, c);
    });
    sock.on("error", () => drop(endpoint, c));
    sock.on("close", () => drop(endpoint, c));
  }

  const close = (endpoint: string): void => {
    const h = hosted.get(endpoint);
    if (h === undefined) return;
    hosted.delete(endpoint);
    for (const c of h.conns.values()) {
      deps.clock.clearTimeout(c.timer);
      c.sock.destroy();
    }
    h.conns.clear();
    h.server.close();
    rmSync(h.path, { force: true });
  };

  return {
    async open(endpoint) {
      if (cfg.platform === "win32" || !ENDPOINT_ID.test(endpoint) || hosted.has(endpoint) || !endpointDirOk(cfg.dir, cfg.uid)) return undefined;
      const path = join(cfg.dir, `${Buffer.from(deps.random(9)).toString("base64url")}.sock`);
      if (Buffer.byteLength(path) > ENDPOINT_HOST_LIMITS.pathBytes) return undefined;
      const server = createServer();
      const h: Hosted = { server, path, conns: new Map() };
      server.on("connection", (sock) => accept(endpoint, h, sock));
      const ok = await new Promise<boolean>((res) => {
        server.once("error", () => res(false));
        server.listen(path, () => res(true));
      });
      if (!ok) {
        server.close();
        return undefined;
      }
      hosted.set(endpoint, h);
      return path;
    },
    close,
    onRelay(msg) {
      if (msg.t === "endpoint-close") return close(msg.endpoint);
      const c = hosted.get(msg.endpoint)?.conns.get(msg.conn);
      if (c === undefined) return;
      c.pending = Math.max(0, c.pending - 1);
      const body = Buffer.from(msg.frame, "utf8");
      const head = Buffer.alloc(4);
      head.writeUInt32BE(body.length, 0);
      c.sock.write(Buffer.concat([head, body]));
      if (msg.close) {
        // After the reply is flushed; the daemon forgets the connection on the `relay-close` (a failed one too).
        hosted.get(msg.endpoint)?.conns.delete(c.id);
        deps.clock.clearTimeout(c.timer);
        c.sock.end();
        deps.send({ t: "relay-close", endpoint: msg.endpoint, conn: c.id });
        return;
      }
      if (c.state === "authing") {
        c.state = "authed";
        arm(msg.endpoint, c, ENDPOINT_HOST_LIMITS.idleMs);
        frames(msg.endpoint, c); // frames that arrived with the auth wait for its answer
      }
    },
    closeAll: () => [...hosted.keys()].forEach(close),
  };
}
