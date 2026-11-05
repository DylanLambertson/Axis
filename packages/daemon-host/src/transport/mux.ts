// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { types } from "node:util";
import { z } from "zod";
import { AxisError } from "@axis/audit";
import type { Connection } from "@axis/daemon";
import { MAX_DEPTH, MAX_MESSAGE_BYTES, MAX_MESSAGE_NODES } from "@axis/protocol";
import { cidSchema, MAX_CONTROL_BYTES } from "../control/messages.js";
import { refuseNonPlainData, type PlainDataLimits } from "../inspect.js";
import type { SupervisorChannel, Unsubscribe } from "../ports/index.js";

/**
 * `ChannelMux` (design section 6.3): virtual connections multiplexed over the one ordered supervisor channel, for
 * hosts that cannot transfer a `MessagePort` (a Node child process, the web host). A frame is
 * `{ kind: "frame", cid, data }` or `{ kind: "close", cid }`; every other message is a control message and goes to
 * the control handlers. Everything is bounded: frame size, queued messages and bytes per connection, and the number
 * of connections. A frame that breaks a bound closes that one connection and is counted, never silently dropped.
 * Nothing here owns a timer, and every listener it adds to the channel is removed by `dispose()`.
 */

export interface MuxLimits {
  /** Virtual connections open at once (default 64). */
  readonly maxConnections: number;
  /** Largest frame payload in bytes, measured by the protocol's bounded walk (default the protocol maximum). */
  readonly maxFrameBytes: number;
  /** Frames held for a connection whose reader has not attached or is behind (default 64). */
  readonly maxQueuedMessages: number;
  /** Bytes held for such a connection (default 2 MiB). */
  readonly maxQueuedBytes: number;
  /** Largest control message in bytes (default 256 KiB). */
  readonly maxControlBytes: number;
}

export const DEFAULT_MUX_LIMITS: MuxLimits = Object.freeze({
  maxConnections: 64,
  maxFrameBytes: MAX_MESSAGE_BYTES,
  maxQueuedMessages: 64,
  maxQueuedBytes: 2 * MAX_MESSAGE_BYTES,
  maxControlBytes: MAX_CONTROL_BYTES,
});

export interface MuxStats {
  readonly connections: number;
  readonly opened: number;
  /** Frames for a `cid` that is not open (never opened, or already closed). */
  readonly unknownFrames: number;
  /** Messages that were not a valid frame or control message. */
  readonly invalidMessages: number;
  readonly oversizeClosed: number;
  readonly overflowClosed: number;
  readonly handlerErrorClosed: number;
  readonly controlDropped: number;
  /** `open` calls refused (limit, bad or duplicate cid). */
  readonly refusedOpens: number;
  /** Sends on a connection that was already closed. */
  readonly sendsAfterClose: number;
}

const frameSchema = z.strictObject({ kind: z.literal("frame"), cid: cidSchema, data: z.unknown() });
const closeSchema = z.strictObject({ kind: z.literal("close"), cid: cidSchema });

/** The own data properties of a plain top-level object, or undefined for a Proxy, an accessor or a symbol key. */
function shallowRecord(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw) || types.isProxy(raw)) return undefined;
  const keys = Reflect.ownKeys(raw);
  if (keys.length > 8) return undefined;
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const d = typeof key === "string" ? Object.getOwnPropertyDescriptor(raw, key) : undefined;
    if (d === undefined || !("value" in d)) return undefined;
    out[key as string] = d.value;
  }
  return out;
}

class Counters {
  opened = 0;
  unknownFrames = 0;
  invalidMessages = 0;
  oversizeClosed = 0;
  overflowClosed = 0;
  handlerErrorClosed = 0;
  controlDropped = 0;
  refusedOpens = 0;
  sendsAfterClose = 0;
}

type CloseReason = "remote" | "local" | "oversize" | "overflow" | "handler" | "channel";

/** One virtual connection. Only the mux creates it. */
class VirtualConnection implements Connection {
  readonly #host: MuxInternals;
  readonly #cid: string;
  readonly #messageHandlers: Array<(raw: unknown) => void> = [];
  readonly #closeHandlers: Array<() => void> = [];
  #queue: Array<{ data: unknown; bytes: number }> = [];
  #queuedBytes = 0;
  #flushScheduled = false;
  #closed = false;

  constructor(host: MuxInternals, cid: string) {
    this.#host = host;
    this.#cid = cid;
  }

  get closed(): boolean {
    return this.#closed;
  }

  send(message: unknown): void {
    if (this.#closed) {
      this.#host.counters.sendsAfterClose++;
      return;
    }
    const refusal = refuseNonPlainData(message, this.#host.frameLimits);
    // The text names the limit, never the message.
    if (refusal !== undefined) throw new AxisError("E_INVALID_ARGUMENT", "Message refused by the channel", { reason: "frame_refused" });
    try {
      this.#host.channel.send({ kind: "frame", cid: this.#cid, data: message });
    } catch {
      this.close("channel");
      throw new AxisError("E_UNAVAILABLE", "The channel is closed", { reason: "channel_closed" });
    }
  }

  onMessage(handler: (raw: unknown) => void): void {
    if (this.#closed || typeof handler !== "function") return;
    this.#messageHandlers.push(handler);
    if (this.#queue.length > 0) this.#scheduleFlush();
  }

  onClose(handler: () => void): void {
    if (typeof handler !== "function") return;
    if (this.#closed) {
      queueMicrotask(() => this.#run(handler));
      return;
    }
    this.#closeHandlers.push(handler);
  }

  close(reason: CloseReason = "local"): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#host.forget(this.#cid, this);
    if (reason !== "remote" && reason !== "channel") {
      try {
        this.#host.channel.send({ kind: "close", cid: this.#cid });
      } catch {
        // The channel is gone; the peer learns it from the channel closing.
      }
    }
    const handlers = this.#closeHandlers.splice(0);
    this.#messageHandlers.length = 0;
    this.#queue = [];
    this.#queuedBytes = 0;
    for (const h of handlers) this.#run(h);
  }

  /** A frame arrived for this connection. */
  deliver(data: unknown): void {
    if (this.#closed) return;
    const refusal = refuseNonPlainData(data, this.#host.frameLimits);
    if (refusal !== undefined) {
      this.#host.counters.oversizeClosed++;
      this.close("oversize");
      return;
    }
    if (this.#messageHandlers.length > 0 && this.#queue.length === 0 && !this.#flushScheduled) {
      this.#dispatch(data);
      return;
    }
    // Plain data was just verified and the walk bounded its size, so measuring by serialising is itself bounded.
    const bytes = JSON.stringify(data).length;
    const limits = this.#host.limits;
    if (this.#queue.length >= limits.maxQueuedMessages || this.#queuedBytes + bytes > limits.maxQueuedBytes) {
      this.#host.counters.overflowClosed++;
      this.close("overflow");
      return;
    }
    this.#queue.push({ data, bytes });
    this.#queuedBytes += bytes;
    if (this.#messageHandlers.length > 0) this.#scheduleFlush();
  }

  // The reader is attached from inside `onMessage`, so queued frames are handed over on a microtask, after the
  // caller finished setting itself up, and in order.
  #scheduleFlush(): void {
    if (this.#flushScheduled) return;
    this.#flushScheduled = true;
    queueMicrotask(() => {
      this.#flushScheduled = false;
      while (!this.#closed && this.#queue.length > 0) {
        const item = this.#queue.shift() as { data: unknown; bytes: number };
        this.#queuedBytes -= item.bytes;
        this.#dispatch(item.data);
      }
    });
  }

  #dispatch(data: unknown): void {
    for (const h of [...this.#messageHandlers]) {
      try {
        h(data);
      } catch {
        // A reader that throws is broken: fail closed for this connection, never for the others.
        this.#host.counters.handlerErrorClosed++;
        this.close("handler");
        return;
      }
    }
  }

  #run(handler: () => void): void {
    try {
      handler();
    } catch {
      // A close handler must not break the others or the mux.
    }
  }
}

interface MuxInternals {
  readonly channel: SupervisorChannel;
  readonly limits: MuxLimits;
  readonly frameLimits: PlainDataLimits;
  readonly counters: Counters;
  forget(cid: string, conn: VirtualConnection): void;
}

export interface ChannelMuxOptions {
  readonly limits?: Partial<MuxLimits>;
}

export class ChannelMux {
  readonly #channel: SupervisorChannel;
  readonly #limits: MuxLimits;
  readonly #counters = new Counters();
  readonly #connections = new Map<string, VirtualConnection>();
  readonly #controlHandlers: Array<(message: unknown) => void> = [];
  readonly #closeHandlers: Array<() => void> = [];
  readonly #unsubscribe: Unsubscribe[] = [];
  #disposed = false;
  #channelClosed = false;

  constructor(channel: SupervisorChannel, options: ChannelMuxOptions = {}) {
    this.#channel = channel;
    this.#limits = { ...DEFAULT_MUX_LIMITS, ...options.limits };
    for (const [name, v] of Object.entries(this.#limits)) {
      if (!Number.isInteger(v) || v < 1) throw new AxisError("E_INVALID_ARGUMENT", "Invalid mux limit", { reason: name });
    }
    this.#unsubscribe.push(channel.onMessage((raw) => this.#onMessage(raw)));
    this.#unsubscribe.push(channel.onClose(() => this.#onChannelClose()));
  }

  get connectionCount(): number {
    return this.#connections.size;
  }

  stats(): MuxStats {
    return Object.freeze({ connections: this.#connections.size, ...this.#counters });
  }

  /** Receive control messages (everything that is not a frame), in order. Plain data of bounded size only. */
  onControl(handler: (message: unknown) => void): Unsubscribe {
    this.#controlHandlers.push(handler);
    return () => void this.#remove(this.#controlHandlers, handler);
  }

  /** The supervisor channel closed. Called at most once per handler; never after `dispose()`. */
  onChannelClose(handler: () => void): Unsubscribe {
    this.#closeHandlers.push(handler);
    return () => void this.#remove(this.#closeHandlers, handler);
  }

  /** Send one control message. Throws `E_UNAVAILABLE` when the channel is closed or the mux disposed. */
  sendControl(message: unknown): void {
    if (this.#disposed || this.#channelClosed) throw new AxisError("E_UNAVAILABLE", "The channel is closed", { reason: "channel_closed" });
    const refusal = refuseNonPlainData(message, { maxBytes: this.#limits.maxControlBytes });
    if (refusal !== undefined) throw new AxisError("E_INVALID_ARGUMENT", "Message refused by the channel", { reason: "control_refused" });
    this.#channel.send(message);
  }

  /**
   * Create the virtual connection `cid`. Undefined when the mux is closed, the id is invalid or already open, or
   * the limit is reached (the peer is then told to close it, unless the id is a live connection's).
   */
  open(cid: string): Connection | undefined {
    if (this.#disposed || this.#channelClosed || !cidSchema.safeParse(cid).success || this.#connections.has(cid)) {
      this.#counters.refusedOpens++;
      return undefined;
    }
    if (this.#connections.size >= this.#limits.maxConnections) {
      this.#counters.refusedOpens++;
      try {
        this.#channel.send({ kind: "close", cid });
      } catch {
        // Channel gone.
      }
      return undefined;
    }
    const conn = new VirtualConnection(this.#internals(), cid);
    this.#connections.set(cid, conn);
    this.#counters.opened++;
    return conn;
  }

  /** Remove every listener, close every connection and refuse all later use. Idempotent. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const u of this.#unsubscribe.splice(0)) u();
    this.#controlHandlers.length = 0;
    this.#closeHandlers.length = 0;
    for (const conn of [...this.#connections.values()]) conn.close("local");
  }

  #internals(): MuxInternals {
    return {
      channel: this.#channel,
      limits: this.#limits,
      frameLimits: { maxBytes: this.#limits.maxFrameBytes, maxNodes: MAX_MESSAGE_NODES, maxDepth: MAX_DEPTH },
      counters: this.#counters,
      forget: (cid, conn) => {
        if (this.#connections.get(cid) === conn) this.#connections.delete(cid);
      },
    };
  }

  #onMessage(raw: unknown): void {
    if (this.#disposed) return;
    const rec = shallowRecord(raw);
    if (rec === undefined) {
      this.#counters.invalidMessages++;
      return;
    }
    if (rec["kind"] === undefined) {
      this.#control(raw);
      return;
    }
    const frame = frameSchema.safeParse(rec);
    if (frame.success) {
      const conn = this.#connections.get(frame.data.cid);
      if (conn === undefined) this.#counters.unknownFrames++;
      else conn.deliver(frame.data.data);
      return;
    }
    const close = closeSchema.safeParse(rec);
    if (close.success) {
      const conn = this.#connections.get(close.data.cid);
      if (conn === undefined) this.#counters.unknownFrames++;
      else conn.close("remote");
      return;
    }
    this.#counters.invalidMessages++;
  }

  #control(raw: unknown): void {
    if (refuseNonPlainData(raw, { maxBytes: this.#limits.maxControlBytes }) !== undefined) {
      this.#counters.invalidMessages++;
      return;
    }
    if (this.#controlHandlers.length === 0) {
      this.#counters.controlDropped++;
      return;
    }
    for (const h of [...this.#controlHandlers]) {
      try {
        h(raw);
      } catch {
        // One failing handler must not stop the others or the channel.
        this.#counters.invalidMessages++;
      }
    }
  }

  #onChannelClose(): void {
    if (this.#channelClosed) return;
    this.#channelClosed = true;
    for (const conn of [...this.#connections.values()]) conn.close("channel");
    const handlers = this.#closeHandlers.splice(0);
    for (const h of handlers) {
      try {
        h();
      } catch {
        // Ignored: see above.
      }
    }
  }

  #remove<T>(list: T[], item: T): void {
    const i = list.indexOf(item);
    if (i >= 0) list.splice(i, 1);
  }
}
