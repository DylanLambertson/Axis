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

function tooLarge(): ProviderError {
  return new ProviderError("invalid_response", { reason: "event_too_large" });
}

/**
 * An incremental, bounded SSE reader. Splits on LF, CRLF and CR at the byte
 * level (those bytes never occur inside a UTF-8 multi-byte sequence), so a line
 * is limited as it arrives and a body with no newline cannot grow the buffer.
 * Only the `event` and `data` fields are used; comments count as ignored. An
 * event left unfinished at the end of the body is dropped (the caller then
 * sees a stream that ended before `message_stop`).
 */
export async function* parseSse(body: BodyStream, limits: AnthropicLimits, counters: EventCounters): AsyncGenerator<SseEvent, void, undefined> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let parts: Uint8Array[] = [];
  let lineBytes = 0;
  let skipLF = false;
  let first = true;
  let eventName = "";
  let data: string[] = [];
  let eventBytes = 0;
  let pending = false;

  const addBytes = (seg: Uint8Array): void => {
    lineBytes += seg.length;
    if (lineBytes > limits.maxLineBytes) throw tooLarge();
    if (seg.length > 0) parts.push(seg.slice());
  };

  const takeLine = (): string => {
    const all = new Uint8Array(lineBytes);
    let off = 0;
    for (const p of parts) {
      all.set(p, off);
      off += p.length;
    }
    parts = [];
    lineBytes = 0;
    try {
      let text = decoder.decode(all);
      if (first) {
        first = false;
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      }
      return text;
    } catch {
      throw new ProviderError("invalid_response", { reason: "bad_encoding" });
    }
  };

  const handleLine = (line: string): SseEvent | undefined => {
    if (line === "") {
      if (!pending) return undefined;
      const ev: SseEvent = { event: eventName === "" ? "message" : eventName, data: data.join("\n") };
      eventName = "";
      data = [];
      eventBytes = 0;
      pending = false;
      counters.countRaw();
      return ev;
    }
    if (line.charCodeAt(0) === 0x3a) {
      counters.countIgnored();
      return undefined;
    }
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") {
      eventName = value;
      pending = true;
    } else if (field === "data") {
      eventBytes += Buffer.byteLength(value, "utf8") + 1;
      if (eventBytes > limits.maxEventBytes) throw tooLarge();
      data.push(value);
      pending = true;
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
      addBytes(chunk.subarray(start, i));
      start = i + 1;
      skipLF = b === CR;
      const ev = handleLine(takeLine());
      if (ev !== undefined) yield ev;
    }
    addBytes(chunk.subarray(start));
  }
}
