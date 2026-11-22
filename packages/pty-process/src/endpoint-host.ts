// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { chmodSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { listenOnPath, type EndpointConn } from "./endpoint-listen.js";
import { ENDPOINT_ID, RELAY_FRAME_CHARS, type RelayInbound, type RelayOutbound } from "./messages.js";
import type { Clock } from "./ports.js";

/**
 * The CLI messaging endpoint's listener, hosted by the pty process (ticket PV-M6 slice 2; ADR 0007 decisions 7.1 to 7.4;
 * docs/design/inter-agent-cli-endpoint.md sections 2 and 3). It owns the transport only: the socket in the user's runtime
 * directory, the connection and frame bounds, and relaying each complete frame to the daemon as its JSON text. It loads no socket
 * built-in itself: it listens through the pinned template `endpoint-listen.ts` (scripts/code-oss/web-rules.mjs rule 1), which
 * gives it a close function and, per connection, a facade (write, end, destroy, three event hooks and `buffered()`). The daemon owns
 * the token, the caller, the message service and every answer; this module never reads a frame's content.
 *
 * - **The directory is the control (Unix).** A real directory, owned by this uid, mode 0700, never a symlink; created 0700 when
 *   absent, refused otherwise. Peer credentials are not checked: Node exposes none (`SO_PEERCRED`, `getpeereid`), and the ADR ships
 *   Unix without a native helper, so the 0700 directory is what keeps other users out. Windows has no endpoint (no pipe helper).
 * - **Bounds (7.4).** At most 4 connections per endpoint (the fifth is closed at accept); 4-byte big-endian length framing; the
 *   first frame (the `auth`) at most 512 bytes and within 2 s, and nothing more until the daemon answered it; later frames at most
 *   64 KiB, at most 4 awaiting an answer; a frame that is not UTF-8 or over its cap closes the connection; an authenticated
 *   connection idle for 10 minutes is closed. Every buffer is bounded by those caps.
 * - **A reader that does not read (review 1 B1).** A reply counts against the 4 unanswered frames until the peer has TAKEN
 *   it (the facade's `buffered()` back at 0), not merely until the daemon produced it; a connection whose unread replies pass
 *   4 MiB is dropped (checked before relaying a frame and after every write), one whose unread replies have not drained for
 *   60 s is dropped, and frames from a connection above half that cap do not refresh its idle timer.
 * - **Backoff.** The daemon marks a token failure (`authFailed`) and closes that connection. Per-peer backoff needs a peer id that
 *   Node does not give, so the bound is one `auth` per connection under the 4-connection cap (the design's stated residual).
 */

export const ENDPOINT_HOST_LIMITS = { connections: 4, authFrameBytes: 512, frameBytes: 64 * 1024, preAuthMs: 2_000, idleMs: 600_000, pendingFrames: 4, pathBytes: 100, writeBufferBytes: 4 * 1024 * 1024, slowReaderMs: 60_000 } as const;

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

/** True for an absolute Unix socket path that no reading of listen() could take for a port (not a numeric string). */
export const isEndpointPath = (p: string): boolean => isAbsolute(p) && p.startsWith("/") && !/^\d+$/.test(p.trim());

interface Conn {
  readonly id: string;
  readonly sock: EndpointConn;
  buf: Buffer;
  /** The `auth` was relayed and not yet answered / it was answered without a close. */
  state: "new" | "authing" | "authed";
  /** Frames relayed to the daemon and not answered yet. */
  pending: number;
  /** Replies written since the peer last took everything (`buffered()` 0): they count as unanswered too. */
  unflushed: number;
  timer: unknown;
  /** Runs while replies are unread; fires the slow-reader drop. */
  slowTimer: unknown;
}
interface Hosted {
  /** Closes the listener (set once it listens). */
  stop: () => void;
  readonly path: string;
  readonly conns: Map<string, Conn>;
}

export function createEndpointHost(
  cfg: EndpointHostConfig,
  deps: { readonly send: (msg: RelayInbound) => boolean; readonly clock: Clock; readonly random: (n: number) => Uint8Array; readonly limits?: { readonly writeBufferBytes?: number; readonly slowReaderMs?: number } },
): EndpointHost {
  const hosted = new Map<string, Hosted>();
  /** Ids being opened (review 1 N2): a second open of the same id while the first awaits is refused. */
  const opening = new Set<string>();
  const writeCap = deps.limits?.writeBufferBytes ?? ENDPOINT_HOST_LIMITS.writeBufferBytes;
  const slowMs = deps.limits?.slowReaderMs ?? ENDPOINT_HOST_LIMITS.slowReaderMs;
  let seq = 0;

  const drop = (endpoint: string, c: Conn): void => {
    const h = hosted.get(endpoint);
    if (h === undefined || h.conns.get(c.id) !== c) return;
    h.conns.delete(c.id);
    deps.clock.clearTimeout(c.timer);
    deps.clock.clearTimeout(c.slowTimer);
    c.sock.destroy();
    deps.send({ t: "relay-close", endpoint, conn: c.id });
  };
  /** The replies the peer has not taken: past the cap the connection is dropped (true); unread ones keep the slow-reader clock running. */
  const backlogged = (endpoint: string, c: Conn): boolean => {
    const b = c.sock.buffered();
    if (b > writeCap) {
      drop(endpoint, c);
      return true;
    }
    if (b === 0) {
      c.unflushed = 0;
      deps.clock.clearTimeout(c.slowTimer);
      c.slowTimer = undefined;
    } else if (c.slowTimer === undefined) {
      c.slowTimer = deps.clock.setTimeout(() => {
        c.slowTimer = undefined;
        if (c.sock.buffered() > 0) drop(endpoint, c);
      }, slowMs);
    }
    return false;
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
      if (backlogged(endpoint, c)) return;
      if (frame.length > RELAY_FRAME_CHARS || c.pending + c.unflushed >= ENDPOINT_HOST_LIMITS.pendingFrames) return drop(endpoint, c);
      c.pending += 1;
      if (c.state === "new") c.state = "authing";
      else if (c.sock.buffered() <= writeCap / 2) arm(endpoint, c, ENDPOINT_HOST_LIMITS.idleMs);
      if (!deps.send({ t: "relay-frame", endpoint, conn: c.id, frame })) return drop(endpoint, c);
    }
  }

  function accept(endpoint: string, h: Hosted, sock: EndpointConn): void {
    if (h.conns.size >= ENDPOINT_HOST_LIMITS.connections) return void sock.destroy();
    const c: Conn = { id: `c${(seq++).toString(36)}`, sock, buf: Buffer.alloc(0), state: "new", pending: 0, unflushed: 0, timer: undefined, slowTimer: undefined };
    h.conns.set(c.id, c);
    arm(endpoint, c, ENDPOINT_HOST_LIMITS.preAuthMs);
    if (!deps.send({ t: "relay-open", endpoint, conn: c.id })) return drop(endpoint, c);
    sock.onData((chunk) => {
      // Bounded: one frame's cap plus its prefix is all a connection may hold unanswered.
      const cap = 4 + (c.state === "authed" ? ENDPOINT_HOST_LIMITS.frameBytes : ENDPOINT_HOST_LIMITS.authFrameBytes);
      if (c.buf.length + chunk.length > cap) return drop(endpoint, c);
      c.buf = Buffer.concat([c.buf, Buffer.from(chunk)]);
      frames(endpoint, c);
    });
    sock.onError(() => drop(endpoint, c));
    sock.onClose(() => drop(endpoint, c));
  }

  const close = (endpoint: string): void => {
    const h = hosted.get(endpoint);
    if (h === undefined) return;
    hosted.delete(endpoint);
    for (const c of h.conns.values()) {
      deps.clock.clearTimeout(c.timer);
      deps.clock.clearTimeout(c.slowTimer);
      c.sock.destroy();
    }
    h.conns.clear();
    h.stop();
    rmSync(h.path, { force: true });
  };

  /** Listen for one endpoint, the id already reserved: the socket path, or undefined when no endpoint can be made. */
  async function openOn(endpoint: string): Promise<string | undefined> {
    const path = join(cfg.dir, `${Buffer.from(deps.random(9)).toString("base64url")}.sock`);
    // Never a port: Node reads a numeric string given to listen() as a TCP port, so only an absolute path is listened on.
    if (!isEndpointPath(path) || Buffer.byteLength(path) > ENDPOINT_HOST_LIMITS.pathBytes) return undefined;
    const h: Hosted = { stop: () => undefined, path, conns: new Map() };
    try {
      h.stop = (await listenOnPath(path, (conn) => accept(endpoint, h, conn))).close;
    } catch {
      return undefined; // the template refused the path, or listening failed (it closed what it opened)
    }
    // The socket file itself 0600, whatever the umask (the 0700 directory is the control; this is depth).
    try {
      chmodSync(path, 0o600);
    } catch {
      h.stop();
      rmSync(path, { force: true });
      return undefined;
    }
    hosted.set(endpoint, h);
    return path;
  }

  return {
    async open(endpoint) {
      // An absolute directory first, before anything touches the file system (a relative one would be made in the working directory).
      if (cfg.platform === "win32" || !ENDPOINT_ID.test(endpoint) || hosted.has(endpoint) || opening.has(endpoint) || !isEndpointPath(cfg.dir) || !endpointDirOk(cfg.dir, cfg.uid)) return undefined;
      opening.add(endpoint);
      try {
        return await openOn(endpoint);
      } finally {
        opening.delete(endpoint);
      }
    },
    close,
    onRelay(msg) {
      if (msg.t === "endpoint-close") return close(msg.endpoint);
      const c = hosted.get(msg.endpoint)?.conns.get(msg.conn);
      if (c === undefined) return;
      c.pending = Math.max(0, c.pending - 1);
      c.unflushed += 1; // unanswered until the peer has taken it
      const body = Buffer.from(msg.frame, "utf8");
      const head = Buffer.alloc(4);
      head.writeUInt32BE(body.length, 0);
      c.sock.write(Buffer.concat([head, body]));
      if (!msg.close && backlogged(msg.endpoint, c)) return;
      if (msg.close) {
        // After the reply is flushed; the daemon forgets the connection on the `relay-close` (a failed one too).
        hosted.get(msg.endpoint)?.conns.delete(c.id);
        deps.clock.clearTimeout(c.timer);
        deps.clock.clearTimeout(c.slowTimer);
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
