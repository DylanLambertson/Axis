// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { EventBody, EventTopic } from "@axis/protocol";

/** A frame as the hub builds it; the session adds `v` and checks it against `serverFrameSchema` before it is sent. */
export type OutboundFrame =
  | { readonly sub: string; readonly seq: number; readonly event: EventBody }
  | { readonly sub: string; readonly seq: number; readonly resync: { readonly reason: "overflow" } }
  | { readonly sub: string; readonly end: { readonly reason: "shutdown" } };

/** Who may see an event. `windowId` set: only subscriptions of that window. */
export interface EventAudience {
  readonly windowId?: string;
}

/** One queue entry per key: a newer event with the same key replaces the queued one (docs/design/events.md section 3). */
export function coalesceKey(body: EventBody): string {
  switch (body.topic) {
    case "workspaces":
      return `workspaces:${body.workspaceId}`;
    case "runs":
      return `runs:${body.runId}`;
    default:
      return body.topic;
  }
}

export interface SubscriptionLimits {
  readonly window: number;
  readonly queueMax: number;
}

/**
 * One subscription: a credit window over a bounded, coalescing queue. It holds at most `queueMax` queued frames and
 * `window` sent sequence numbers, whatever the client does; an overflow empties the queue and owes the client one
 * `resync`. Nothing is sent before `activate` (the session calls it once the `subscribe` reply is on the wire).
 */
export class Subscription {
  readonly id: string;
  readonly topics: ReadonlySet<EventTopic>;
  readonly windowId: string;
  readonly #limits: SubscriptionLimits;
  readonly #send: (frame: OutboundFrame) => void;
  readonly #head: () => number;
  readonly #queue = new Map<string, { readonly seq: number; readonly body: EventBody }>();
  /** Sequence numbers sent and not yet acknowledged, ascending. */
  readonly #sent: number[] = [];
  #active = false;
  #closed = false;
  #needResync = false;
  /** Events dropped by overflows (counted, never silent: the client gets a resync). */
  dropped = 0;

  constructor(
    id: string,
    topics: ReadonlySet<EventTopic>,
    windowId: string,
    limits: SubscriptionLimits,
    send: (frame: OutboundFrame) => void,
    head: () => number,
  ) {
    this.id = id;
    this.topics = topics;
    this.windowId = windowId;
    this.#limits = limits;
    this.#send = send;
    this.#head = head;
  }

  get queued(): number {
    return this.#queue.size;
  }
  get outstanding(): number {
    return this.#sent.length;
  }
  get active(): boolean {
    return this.#active;
  }

  matches(body: EventBody, audience: EventAudience | undefined): boolean {
    if (!this.topics.has(body.topic)) return false;
    return audience?.windowId === undefined || audience.windowId === this.windowId;
  }

  /** Queue an event (coalescing by key), or drop everything and owe a resync on overflow; then send what the window allows. */
  offer(seq: number, body: EventBody): void {
    if (this.#closed) return;
    if (this.#needResync) {
      this.dropped++; // a resync is owed: the re-read covers this event too
      return;
    }
    const key = coalesceKey(body);
    if (this.#queue.has(key)) this.#queue.delete(key);
    else if (this.#queue.size >= this.#limits.queueMax) {
      this.dropped += this.#queue.size + 1;
      this.#queue.clear();
      this.#needResync = true;
      this.#pump();
      return;
    }
    this.#queue.set(key, { seq, body });
    this.#pump();
  }

  activate(): void {
    if (this.#closed || this.#active) return;
    this.#active = true;
    this.#pump();
  }

  /** Credit: every sent frame up to `seq` is acknowledged. A larger `seq` than anything sent acknowledges all. */
  ack(seq: number): void {
    if (this.#closed) return;
    while (this.#sent.length > 0 && (this.#sent[0] as number) <= seq) this.#sent.shift();
    this.#pump();
  }

  /** Stop for good. With `reason`, an active subscription gets one final `end` frame (outside the window). */
  close(reason?: "shutdown"): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#queue.clear();
    this.#sent.length = 0;
    if (reason !== undefined && this.#active) this.#send({ sub: this.id, end: { reason } });
  }

  #pump(): void {
    if (!this.#active) return;
    while (!this.#closed && this.#sent.length < this.#limits.window) {
      if (this.#needResync) {
        this.#needResync = false;
        const seq = this.#head();
        this.#sent.push(seq);
        this.#send({ sub: this.id, seq, resync: { reason: "overflow" } });
        continue;
      }
      const next = this.#queue.entries().next();
      if (next.done === true) return;
      const [key, entry] = next.value;
      this.#queue.delete(key);
      this.#sent.push(entry.seq);
      this.#send({ sub: this.id, seq: entry.seq, event: entry.body });
    }
  }
}
