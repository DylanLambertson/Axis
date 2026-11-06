// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { randomBytes } from "node:crypto";
import {
  EVENT_QUEUE_MAX,
  EVENT_RING_SIZE,
  EVENT_WINDOW,
  MAX_SUBSCRIPTIONS_PER_CONNECTION,
  MAX_SUBSCRIPTIONS_TOTAL,
  eventBodySchema,
  eventsSubscribeRequestSchema,
  eventsUnsubscribeRequestSchema,
  type EventBody,
  type EventTopic,
} from "@axis/protocol";
import { DaemonError } from "./errors.js";
import { Subscription, type EventAudience, type OutboundFrame } from "./event-sub.js";
import type { Handler, HandlerContext, Identity } from "./types.js";

export type { EventAudience, OutboundFrame } from "./event-sub.js";

export interface EventHubOptions {
  readonly window?: number;
  readonly queueMax?: number;
  readonly ringSize?: number;
  readonly maxPerConnection?: number;
  readonly maxTotal?: number;
  /** Local diagnostics (a refused body, a throwing send). Receives fixed text only. */
  readonly onInternalError?: (where: string, error: unknown) => void;
}

/** What the session holds for its connection. Every method is a no-op after `detach`. */
export interface EventAttachment {
  /** The reply to `requestId` was sent (`ok`) or was not a success: activate or drop the subscriptions it made. */
  replied(requestId: string, ok: boolean): void;
  ack(subscriptionId: string, seq: number): void;
  detach(): void;
}

interface Attached {
  readonly identity: Identity;
  readonly send: (frame: OutboundFrame) => void;
  readonly subs: Map<string, Subscription>;
  /** Subscriptions made by a request whose reply has not been sent yet, by request id. */
  readonly pending: Map<string, Subscription>;
}

const token = (): string => randomBytes(16).toString("base64url");

/**
 * The daemon's event hub (docs/design/events.md). Sources call `publish`; the daemon attaches each verified session;
 * the `axis.events/1` handlers come from `handlers()` and are registered like any other (policy, audit, coverage).
 *
 * `publish` never blocks and never throws to its caller: it validates the body against the closed, strict schema
 * (anything else is dropped and counted), stamps the next sequence number, keeps it in a bounded ring for resume, and
 * offers it to each matching subscription, whose bounded queue and credit window do the rest.
 */
export class EventHub {
  readonly epoch: string = token();
  readonly #window: number;
  readonly #queueMax: number;
  readonly #ringSize: number;
  readonly #maxPer: number;
  readonly #maxTotal: number;
  readonly #onError: ((where: string, error: unknown) => void) | undefined;
  readonly #ring: Array<{ readonly seq: number; readonly body: EventBody; readonly audience: EventAudience | undefined }> = [];
  readonly #conns = new Map<string, Attached>();
  #seq = 0;
  #total = 0;
  #ended = false;
  #refused = 0;

  constructor(options: EventHubOptions = {}) {
    const n = (v: number | undefined, d: number, max: number): number => (v !== undefined && Number.isInteger(v) && v >= 1 && v <= max ? v : d);
    this.#window = n(options.window, EVENT_WINDOW, 1024);
    this.#queueMax = n(options.queueMax, EVENT_QUEUE_MAX, 4096);
    this.#ringSize = n(options.ringSize, EVENT_RING_SIZE, 65_536);
    this.#maxPer = n(options.maxPerConnection, MAX_SUBSCRIPTIONS_PER_CONNECTION, 64);
    this.#maxTotal = n(options.maxTotal, MAX_SUBSCRIPTIONS_TOTAL, 4096);
    this.#onError = options.onInternalError;
  }

  /** The sequence number of the newest event (0 before the first). */
  get head(): number {
    return this.#seq;
  }
  get subscriptionCount(): number {
    return this.#total;
  }
  /** Bodies refused by `publish` (not in the closed schema, or an approvals event without a window). */
  get refused(): number {
    return this.#refused;
  }
  /** Events dropped by overflows of the live subscriptions (each overflow also owes its client a resync). */
  get dropped(): number {
    let n = 0;
    for (const c of this.#conns.values()) for (const s of c.subs.values()) n += s.dropped;
    return n;
  }
  get ended(): boolean {
    return this.#ended;
  }

  /** Windows that have a subscription to `topic` (active or not yet answered). */
  windowsFor(topic: EventTopic): Set<string> {
    const out = new Set<string>();
    for (const c of this.#conns.values()) for (const s of c.subs.values()) if (s.topics.has(topic)) out.add(s.windowId);
    return out;
  }

  /** Publish one event. False when it was refused or the hub has ended; never throws. */
  publish(body: unknown, audience?: EventAudience): boolean {
    if (this.#ended) return false;
    let parsed: EventBody;
    try {
      const checked = eventBodySchema.safeParse(body);
      // An approvals event is scoped to one window by definition: without one it would reach every window.
      const windowId = audience?.windowId;
      if (!checked.success || (checked.data.topic === "approvals" && (typeof windowId !== "string" || windowId.length === 0))) {
        this.#refused++;
        this.#onError?.("events", new Error("event body refused"));
        return false;
      }
      parsed = checked.data;
    } catch {
      this.#refused++;
      return false;
    }
    const scope: EventAudience | undefined = audience?.windowId === undefined ? undefined : Object.freeze({ windowId: audience.windowId });
    const seq = ++this.#seq;
    this.#ring.push({ seq, body: parsed, audience: scope });
    if (this.#ring.length > this.#ringSize) this.#ring.shift();
    for (const c of [...this.#conns.values()]) {
      for (const s of [...c.subs.values()]) {
        try {
          if (s.matches(parsed, scope)) s.offer(seq, parsed);
        } catch (e) {
          this.#onError?.("events", e);
        }
      }
    }
    return true;
  }

  /** Daemon only: bind a verified session. `send` must never throw (the session closes itself on a failed send). */
  attach(identity: Identity, send: (frame: OutboundFrame) => void): EventAttachment {
    const key = identity.connectionId;
    const self: Attached = { identity, send, subs: new Map(), pending: new Map() };
    this.#conns.set(key, self);
    const live = (): boolean => this.#conns.get(key) === self;
    return {
      replied: (requestId, ok) => {
        if (!live()) return;
        const sub = self.pending.get(requestId);
        if (sub === undefined) return;
        self.pending.delete(requestId);
        if (ok) sub.activate();
        else this.#remove(self, sub);
      },
      ack: (subscriptionId, seq) => {
        if (live()) self.subs.get(subscriptionId)?.ack(seq);
      },
      detach: () => {
        if (!live()) return;
        this.#conns.delete(key);
        for (const s of self.subs.values()) s.close();
        this.#total -= self.subs.size;
        self.subs.clear();
        self.pending.clear();
      },
    };
  }

  /** Graceful shutdown: every active subscription gets `end { reason }`, all are removed, and nothing is published again. */
  endAll(reason: "shutdown"): void {
    this.#ended = true;
    for (const c of this.#conns.values()) {
      for (const s of c.subs.values()) {
        try {
          s.close(reason);
        } catch (e) {
          this.#onError?.("events", e);
        }
      }
      this.#total -= c.subs.size;
      c.subs.clear();
      c.pending.clear();
    }
    this.#ring.length = 0;
  }

  /** The `axis.events/1` handlers. Register them through the host's registrar so policy, audit and coverage apply. */
  handlers(): { readonly subscribe: Handler; readonly unsubscribe: Handler } {
    return {
      subscribe: (ctx: HandlerContext, payload: never) => this.#subscribe(ctx, payload),
      unsubscribe: (ctx: HandlerContext, payload: never) => this.#unsubscribe(ctx, payload),
    };
  }

  #subscribe(ctx: HandlerContext, payload: unknown): unknown {
    if (ctx.signal.aborted) throw new DaemonError("E_CANCELLED", "The request was cancelled");
    // Defence in depth behind the policy row: only the user's own attested connection subscribes.
    if (ctx.identity.actor !== "user") throw new DaemonError("E_NOT_FOUND", "Not available");
    if (this.#ended) throw new DaemonError("E_UNAVAILABLE", "The daemon is shutting down", { reason: "shutting_down" });
    const conn = this.#conns.get(ctx.identity.connectionId);
    if (conn === undefined) throw new DaemonError("E_UNAVAILABLE", "Events are not available on this connection");
    const req = eventsSubscribeRequestSchema.safeParse(payload);
    if (!req.success) throw new DaemonError("E_INVALID_ARGUMENT", "Invalid request");
    if (conn.subs.size >= this.#maxPer || this.#total >= this.#maxTotal) throw new DaemonError("E_BACKPRESSURE", "Too many event subscriptions");
    if (conn.pending.has(ctx.requestId)) throw new DaemonError("E_CONFLICT", "That request already made a subscription");
    const sub = new Subscription(
      token(),
      new Set(req.data.topics),
      ctx.identity.windowId,
      { window: this.#window, queueMax: this.#queueMax },
      conn.send,
      () => this.#seq,
    );
    conn.subs.set(sub.id, sub);
    conn.pending.set(ctx.requestId, sub);
    this.#total++;
    const from = req.data.resumeFrom;
    let resumed = false;
    if (from !== undefined && from.epoch === this.epoch && from.seq <= this.#seq) {
      const oldest = this.#ring.length > 0 ? (this.#ring[0] as { seq: number }).seq : this.#seq + 1;
      // Everything after `from.seq` must still be in the ring, or the client would miss events without knowing it.
      if (from.seq >= oldest - 1) {
        resumed = true;
        for (const e of this.#ring) if (e.seq > from.seq && sub.matches(e.body, e.audience)) sub.offer(e.seq, e.body);
      }
    }
    return { subscriptionId: sub.id, epoch: this.epoch, seq: this.#seq, resumed, window: this.#window };
  }

  #unsubscribe(ctx: HandlerContext, payload: unknown): unknown {
    if (ctx.signal.aborted) throw new DaemonError("E_CANCELLED", "The request was cancelled");
    const req = eventsUnsubscribeRequestSchema.safeParse(payload);
    if (!req.success) throw new DaemonError("E_INVALID_ARGUMENT", "Invalid request");
    const conn = this.#conns.get(ctx.identity.connectionId);
    const sub = conn?.subs.get(req.data.subscriptionId);
    // One answer for unknown and for another connection's id: nothing shows which ids exist.
    if (conn === undefined || sub === undefined) throw new DaemonError("E_NOT_FOUND", "No such subscription");
    this.#remove(conn, sub);
    return { subscriptionId: sub.id };
  }

  #remove(conn: Attached, sub: Subscription): void {
    if (conn.subs.get(sub.id) !== sub) return;
    sub.close();
    conn.subs.delete(sub.id);
    for (const [rid, s] of conn.pending) if (s === sub) conn.pending.delete(rid);
    this.#total--;
  }
}
