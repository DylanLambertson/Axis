// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { MAX_ACTIVITY_TEXT, REFUSED_ACTIVITY, type ComposerMode, type RunEvent } from "@axis/protocol";
import type { ComposerEventsPage } from "../ports/composer.js";

/**
 * The activity of composer runs, in memory and bounded (docs/design/composer-runtime.md section 3). Each run keeps at
 * most `maxEvents` events and `maxTextChars` characters of model text and approval preview heads (the oldest go first, except `request` events, which go last; a reader whose cursor
 * fell behind simply continues from what is left); at most `maxRuns` runs are kept, the oldest finished one is evicted
 * first. This is the live view; the service also writes each event to the journal (J2), which answers once a run is
 * no longer held here (after a restart, or once evicted).
 */

export type ActivityInput = DistributiveOmit<RunEvent, "seq" | "at">;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export interface RunMeta {
  readonly mode: ComposerMode;
  readonly providerId: string;
  readonly modelId: string;
}

interface Entry {
  readonly meta: RunMeta;
  readonly events: RunEvent[];
  seq: number;
  textChars: number;
  done: boolean;
  usage: { inputTokens: number; outputTokens: number; requests: number } | undefined;
}

export interface ActivityLimits {
  readonly maxEvents?: number;
  readonly maxTextChars?: number;
  readonly maxRuns?: number;
}

const token = (ch: string): string => (REFUSED_ACTIVITY.test(ch) ? `\\u{${(ch.codePointAt(0) as number).toString(16)}}` : ch);

/**
 * Model text as activity text: every refused code point written as `\u{hex}`, split into pieces of at most
 * `MAX_ACTIVITY_TEXT` units on code point boundaries. An empty text gives no piece.
 */
export function activityTexts(raw: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (const ch of raw) {
    const t = token(ch);
    if (cur.length + t.length > MAX_ACTIVITY_TEXT) {
      out.push(cur);
      cur = "";
    }
    cur += t;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

/** The text an event holds: model output, or the content head of an approval preview (both count against `maxTextChars`). */
const charsOf = (ev: RunEvent): number => (ev.type === "text" ? ev.text.length : ev.type === "approval" ? (ev.preview?.content?.head.length ?? 0) : 0);

export class RunActivity {
  readonly #runs = new Map<string, Entry>();
  readonly #maxEvents: number;
  readonly #maxText: number;
  readonly #maxRuns: number;
  readonly #now: () => number;

  constructor(now: () => number, limits: ActivityLimits = {}) {
    this.#now = now;
    this.#maxEvents = limits.maxEvents ?? 1000;
    this.#maxText = limits.maxTextChars ?? 524_288;
    this.#maxRuns = limits.maxRuns ?? 32;
  }

  open(runId: string, meta: RunMeta): void {
    this.#runs.delete(runId);
    this.#runs.set(runId, { meta, events: [], seq: 0, textChars: 0, done: false, usage: undefined });
    if (this.#runs.size <= this.#maxRuns) return;
    // Evict the oldest finished run; a live run is never evicted (the service bounds how many are live).
    for (const [id, e] of this.#runs) {
      if (e.done) {
        this.#runs.delete(id);
        if (this.#runs.size <= this.#maxRuns) return;
      }
    }
  }

  meta(runId: string): RunMeta | undefined {
    return this.#runs.get(runId)?.meta;
  }

  /** The run's last reported usage (kept after its events were evicted from the ring). */
  usage(runId: string): { inputTokens: number; outputTokens: number; requests: number } | undefined {
    const u = this.#runs.get(runId)?.usage;
    return u === undefined ? undefined : { ...u };
  }

  /** Append; returns the events added (a long text becomes several), none for a run that is closed or not held. */
  push(runId: string, input: ActivityInput): RunEvent[] {
    const e = this.#runs.get(runId);
    if (e === undefined || e.done) return [];
    if (input.type === "usage") e.usage = { ...input.usage };
    const at = new Date(this.#now()).toISOString();
    const added: RunEvent[] =
      input.type === "text" ? activityTexts(input.text).map((text) => ({ type: "text", text, seq: ++e.seq, at })) : [{ ...input, seq: ++e.seq, at } as RunEvent];
    for (const ev of added) this.#add(e, ev);
    return structuredClone(added);
  }

  /** The run ended: its last event is in, and readers that reached it are told `complete`. */
  close(runId: string): void {
    const e = this.#runs.get(runId);
    if (e !== undefined) e.done = true;
  }

  read(runId: string, afterSeq: number, limit: number): ComposerEventsPage {
    const e = this.#runs.get(runId);
    if (e === undefined) return { events: [], nextSeq: 0, complete: true, available: false };
    const events = e.events.filter((x) => x.seq > afterSeq).slice(0, limit);
    const last = events[events.length - 1];
    const nextSeq = last === undefined ? Math.min(afterSeq, e.seq) : last.seq;
    return { events: structuredClone(events), nextSeq, complete: e.done && nextSeq >= e.seq, available: true };
  }

  #add(e: Entry, ev: RunEvent): void {
    e.events.push(ev);
    e.textChars += charsOf(ev);
    while (e.events.length > this.#maxEvents || e.textChars > this.#maxText) {
      // A `request` event (where a provider request went, PRV-4) outlives the other events: the oldest other event goes first.
      // Requests are bounded by the run's turns, and the oldest goes only when nothing else is left.
      const at = e.events.findIndex((x) => x.type !== "request");
      const [old] = e.events.splice(at < 0 ? 0 : at, 1) as [RunEvent];
      e.textChars -= charsOf(old);
    }
  }
}
