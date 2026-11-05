// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { ProviderError } from "@axis/providers";
import type { AnthropicLimits } from "./limits.js";
import type { BodyStream } from "./transport.js";

export interface SseEvent {
  readonly event: string;
  readonly data: string;
}

/** Counts shared by the parser and the event mapper; each check throws `invalid_response` with a fixed reason. */
export class EventCounters {
  raw = 0;
  ignored = 0;
  constructor(private readonly limits: AnthropicLimits) {}

  countRaw(): void {
    if (++this.raw > this.limits.maxRawEvents) throw new ProviderError("invalid_response", { reason: "too_many_events" });
  }

  countIgnored(): void {
    if (++this.ignored > this.limits.maxIgnoredEvents) throw new ProviderError("invalid_response", { reason: "too_many_ignored_events" });
  }
}

const LF = 0x0a;
const CR = 0x0d;
const INITIAL_CAPACITY = 256;
/** A buffer that grew past this is shrunk again after its line is taken. */
const KEEP_CAPACITY = 65_536;

function tooLarge(): ProviderError {
  return new ProviderError("invalid_response", { reason: "event_too_large" });
}

/** One line under construction: a growable buffer, so a long line arriving in tiny chunks costs one copy (N6). */
class LineBuffer {
  private buf = new Uint8Array(INITIAL_CAPACITY);
  length = 0;
  constructor(private readonly max: number) {}

  append(seg: Uint8Array): void {
    if (seg.length === 0) return;
    const need = this.length + seg.length;
    if (need > this.max) throw tooLarge();
    if (need > this.buf.length) {
      const grown = new Uint8Array(Math.min(Math.max(need, this.buf.length * 2), this.max));
      grown.set(this.buf.subarray(0, this.length));
      this.buf = grown;
    }
    this.buf.set(seg, this.length);
    this.length = need;
  }

  /** The bytes of the line; valid until the next `append`. */
  view(): Uint8Array {
    return this.buf.subarray(0, this.length);
  }

  reset(): void {
    this.length = 0;
    if (this.buf.length > KEEP_CAPACITY) this.buf = new Uint8Array(INITIAL_CAPACITY);
  }
}

/**
 * An incremental, bounded SSE reader. Splits on LF, CRLF and CR at the byte
 * level (those bytes never occur inside a UTF-8 multi-byte sequence), so a line
 * is limited as it arrives and a body with no newline cannot grow the buffer.
 *
 * Only `event` and `data` carry anything. Every line that does not belong to an
 * event that gets dispatched counts as an ignored event (comments, blank lines
 * with nothing pending, `id:`, `retry:`, unknown fields, an `event:` that
 * overwrites another, an event with no data), so no kind of line can be sent
 * for free (S6). An event left unfinished at the end of the body is dropped
 * (the caller then sees a stream that ended before `message_stop`).
 */
export async function* parseSse(body: BodyStream, limits: AnthropicLimits, counters: EventCounters): AsyncGenerator<SseEvent, void, undefined> {
  // BOM handling is ours (first line only): the decoder must not strip one from every line (N5).
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const line = new LineBuffer(limits.maxLineBytes);
  let skipLF = false;
  let first = true;
  let eventName = "";
  let data: string[] = [];
  let eventBytes = 0;
  let pending = false;
  let sawEventField = false;

  const takeLine = (): string => {
    if (line.length === 0) return "";
    try {
      let text = decoder.decode(line.view());
      if (first && text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      return text;
    } catch {
      throw new ProviderError("invalid_response", { reason: "bad_encoding" });
    } finally {
      line.reset();
    }
  };

  const handleLine = (text: string): SseEvent | undefined => {
    if (text === "") {
      const ready = pending && data.length > 0;
      const ev: SseEvent | undefined = ready ? { event: eventName === "" ? "message" : eventName, data: data.join("\n") } : undefined;
      eventName = "";
      data = [];
      eventBytes = 0;
      pending = false;
      sawEventField = false;
      if (ev === undefined) {
        // A blank line with nothing pending, or an event with no data, is skipped but costs budget.
        counters.countIgnored();
        return undefined;
      }
      counters.countRaw();
      return ev;
    }
    if (text.charCodeAt(0) === 0x3a) {
      counters.countIgnored();
      return undefined;
    }
    const colon = text.indexOf(":");
    const field = colon === -1 ? text : text.slice(0, colon);
    let value = colon === -1 ? "" : text.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") {
      // A second `event:` in one event, empty or not, is ignored input and costs budget.
      if (sawEventField) counters.countIgnored();
      sawEventField = true;
      eventName = value;
      pending = true;
    } else if (field === "data") {
      eventBytes += Buffer.byteLength(value, "utf8") + 1;
      if (eventBytes > limits.maxEventBytes) throw tooLarge();
      data.push(value);
      pending = true;
    } else {
      counters.countIgnored();
    }
    return undefined;
  };

  for (;;) {
    const chunk = await body.next();
    if (chunk === undefined) return;
    let start = 0;
    for (let i = 0; i < chunk.length; i++) {
      const b = chunk[i] as number;
      if (skipLF) {
        skipLF = false;
        if (b === LF) {
          start = i + 1;
          continue;
        }
      }
      if (b !== LF && b !== CR) continue;
      line.append(chunk.subarray(start, i));
      start = i + 1;
      skipLF = b === CR;
      const ev = handleLine(takeLine());
      first = false;
      if (ev !== undefined) yield ev;
    }
    line.append(chunk.subarray(start));
  }
}
