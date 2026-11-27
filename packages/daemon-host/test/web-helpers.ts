// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { randomBytes } from "node:crypto";
import { connect, type Socket } from "node:net";
import type { Connection, Identity } from "@axis/daemon";
import { ChannelMux, createAttestationVerifier, type Attestation, type ChannelFlow } from "../src/index.js";
import { startWebHost, type WebHost, type WebHostEvent, type WebHostOptions } from "../src/web/index.js";
import { memoryChannelPair, type MemoryEnd } from "../testing/memory-channel.js";
import { fakeClock } from "./helpers.js";

/** Helpers for the web host tests: a raw WebSocket client over a real loopback socket, and an in-memory daemon side. */

export const ORIGIN = "http://127.0.0.1:5173";

/** A backlog the test drives by hand. */
export function manualFlow(): ChannelFlow & { set(n: number): void; drain(): void; fireDrain(): void; listeners(): number } {
  let n = 0;
  const handlers: Array<() => void> = [];
  return {
    pending: () => n,
    onDrain: (h) => {
      handlers.push(h);
      return () => void handlers.splice(handlers.indexOf(h), 1);
    },
    set: (v) => void (n = v),
    drain: () => {
      n = 0;
      for (const h of [...handlers]) h();
    },
    /** Report a drain without emptying the backlog (the next forward finds it full again). */
    fireDrain: () => {
      for (const h of [...handlers]) h();
    },
    listeners: () => handlers.length,
  };
}

/** One masked client frame. */
export function clientFrame(opcode: number, payload: Buffer | string, o: { fin?: boolean; mask?: boolean; rsv?: number; len?: "16" | "64" } = {}): Buffer {
  const data = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
  const n = data.length;
  const masked = o.mask ?? true;
  const head: number[] = [((o.fin ?? true) ? 0x80 : 0) | ((o.rsv ?? 0) << 4) | opcode];
  const m = masked ? 0x80 : 0;
  let ext = Buffer.alloc(0);
  if (o.len === "64" || n >= 65_536) {
    head.push(m | 127);
    ext = Buffer.alloc(8);
    ext.writeBigUInt64BE(BigInt(n));
  } else if (o.len === "16" || n >= 126) {
    head.push(m | 126);
    ext = Buffer.alloc(2);
    ext.writeUInt16BE(n);
  } else head.push(m | n);
  const key = masked ? randomBytes(4) : Buffer.alloc(0);
  const body = Buffer.from(data);
  if (masked) for (let i = 0; i < body.length; i++) body[i] = (body[i] as number) ^ (key[i & 3] as number);
  return Buffer.concat([Buffer.from(head), ext, key, body]);
}

export interface ServerFrame {
  readonly opcode: number;
  readonly payload: Buffer;
}

/** Parse unmasked server frames from `buf`; returns the frames and the unused rest. */
export function serverFrames(buf: Buffer): { frames: ServerFrame[]; rest: Buffer } {
  const frames: ServerFrame[] = [];
  let at = 0;
  for (;;) {
    if (buf.length - at < 2) break;
    const len7 = (buf[at + 1] as number) & 0x7f;
    let off = at + 2;
    let len = len7;
    if (len7 === 126) {
      if (buf.length - at < 4) break;
      len = buf.readUInt16BE(at + 2);
      off = at + 4;
    } else if (len7 === 127) {
      if (buf.length - at < 10) break;
      len = Number(buf.readBigUInt64BE(at + 2));
      off = at + 10;
    }
    if (buf.length < off + len) break;
    frames.push({ opcode: (buf[at] as number) & 0x0f, payload: buf.subarray(off, off + len) });
    at = off + len;
  }
  return { frames, rest: buf.subarray(at) };
}

export interface RawClient {
  readonly socket: Socket;
  /** The status code of the HTTP answer. */
  readonly status: number;
  /** The answer's header block (lower-cased names). */
  readonly headers: Readonly<Record<string, string>>;
  /** Resolves with the next server frame (after the handshake). */
  next(): Promise<ServerFrame>;
  /** Resolves when the socket has closed. */
  readonly ended: Promise<void>;
  send(frame: Buffer): void;
}

export function upgradeHeaders(port: number, token: string, over: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    host: `127.0.0.1:${port}`,
    upgrade: "websocket",
    connection: "Upgrade",
    "sec-websocket-version": "13",
    "sec-websocket-key": randomBytes(16).toString("base64"),
    origin: ORIGIN,
    "sec-websocket-protocol": `axis.v1, axis.auth.${token}`,
    ...over,
  };
}

/** Open a raw socket, send an upgrade request and read the answer's head. */
export function rawUpgrade(port: number, headers: Record<string, string | undefined>, requestLine = "GET /axis/1 HTTP/1.1"): Promise<RawClient> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    let buf: Buffer = Buffer.alloc(0);
    let head: { status: number; headers: Record<string, string> } | undefined;
    const frames: ServerFrame[] = [];
    const waiters: Array<(f: ServerFrame) => void> = [];
    const ended = new Promise<void>((r) => socket.once("close", () => r()));
    socket.on("error", () => undefined);
    socket.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (head === undefined) {
        const end = buf.indexOf("\r\n\r\n");
        if (end < 0) return;
        const lines = buf.subarray(0, end).toString("latin1").split("\r\n");
        const hs: Record<string, string> = {};
        for (const l of lines.slice(1)) {
          const i = l.indexOf(":");
          hs[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
        }
        head = { status: Number((lines[0] ?? "").split(" ")[1]), headers: hs };
        buf = buf.subarray(end + 4);
        resolve(client);
      }
      const parsed = serverFrames(buf);
      buf = parsed.rest;
      for (const f of parsed.frames) {
        const w = waiters.shift();
        if (w !== undefined) w(f);
        else frames.push(f);
      }
    });
    socket.once("close", () => {
      if (head === undefined) reject(new Error("closed before an answer"));
    });
    const client: RawClient = {
      socket,
      get status() {
        return head?.status ?? 0;
      },
      get headers() {
        return head?.headers ?? {};
      },
      next: () => {
        const f = frames.shift();
        return f !== undefined ? Promise.resolve(f) : new Promise((r) => waiters.push(r));
      },
      ended,
      send: (frame) => void socket.write(frame),
    };
    const text = [requestLine, ...Object.entries(headers).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}: ${v}`), "", ""].join("\r\n");
    socket.write(text);
  });
}

export const closeCodeOf = (f: ServerFrame): number => (f.opcode === 8 && f.payload.length >= 2 ? f.payload.readUInt16BE(0) : -1);

/**
 * A daemon side in memory: the supervisor mux on one end of a memory channel, a daemon mux on the other that answers
 * `connect` by verifying the attestation (the real verifier) and echoing every frame back as `{ echo, identity }`.
 */
export interface MemoryRig {
  readonly host: WebHost;
  readonly token: string;
  readonly flow: ReturnType<typeof manualFlow>;
  readonly key: Buffer;
  readonly events: Array<{ event: WebHostEvent; detail?: unknown }>;
  /** Connections the daemon side accepted, by cid. */
  readonly daemon: Map<string, { conn: Connection; identity: Identity; received: unknown[]; closed: boolean }>;
  /** Every control message the daemon side received. */
  readonly control: unknown[];
  readonly supEnd: MemoryEnd;
  readonly supMux: ChannelMux;
  dispose(): Promise<void>;
}

export async function memoryRig(options: { config?: Record<string, unknown>; key?: Buffer; echo?: boolean; keyCopy?: (k: Uint8Array) => Uint8Array } = {}): Promise<MemoryRig> {
  const { a, b } = memoryChannelPair();
  const supMux = new ChannelMux(a);
  const daemonMux = new ChannelMux(b);
  const key = randomBytes(32);
  const clock = fakeClock();
  const verifier = createAttestationVerifier({ key, clock });
  const daemon: MemoryRig["daemon"] = new Map();
  const control: unknown[] = [];
  daemonMux.onControl((m) => {
    control.push(m);
    const msg = m as { type?: string; cid?: string; attestation?: Attestation };
    if (msg.type !== "connect" || msg.cid === undefined) return;
    const conn = daemonMux.open(msg.cid);
    if (conn === undefined) return;
    const identity = verifier.verify(msg.attestation);
    if (identity === undefined) return conn.close();
    const entry = { conn, identity, received: [] as unknown[], closed: false };
    daemon.set(msg.cid, entry);
    conn.onClose(() => void (entry.closed = true));
    conn.onMessage((d) => {
      entry.received.push(d);
      if (options.echo !== false) conn.send({ echo: d, actor: identity.actor, clientKind: identity.clientKind, windowId: identity.windowId, trusted: identity.trusted });
    });
  });
  const flow = manualFlow();
  const events: MemoryRig["events"] = [];
  const opts: WebHostOptions = {
    config: { enabled: true, port: 0, allowedOrigins: [ORIGIN], ...options.config },
    mux: supMux,
    flow,
    attestationKey: options.key ?? key,
    clock,
    log: (event, detail) => void events.push({ event, detail }),
    ...(options.keyCopy === undefined ? {} : { keyCopy: options.keyCopy }),
  };
  const host = await startWebHost(opts);
  return {
    host,
    token: host.takeToken(),
    flow,
    key,
    events,
    daemon,
    control,
    supEnd: a,
    supMux,
    dispose: async () => {
      await host.dispose();
      supMux.dispose();
      daemonMux.dispose();
      verifier.close();
    },
  };
}

/** Resolve once `predicate` holds, checking after each turn of the event loop (bounded by a count, not by time). */
export async function until(predicate: () => boolean, turns = 200_000): Promise<void> {
  for (let i = 0; i < turns; i++) {
    if (predicate()) return;
    await new Promise<void>((r) => setImmediate(r));
  }
  throw new Error("condition not reached");
}
