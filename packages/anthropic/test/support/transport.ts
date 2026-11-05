// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// A fake `fetch` for the adapter's tests: records every call, serves scripted
// responses and counts open response bodies. Nothing here touches the network.
import type { BodyReader, FetchInit, FetchLike, ResponseBody, ResponseLike } from "../../src/index.js";

export interface RecordedCall {
  readonly url: string;
  readonly init: FetchInit;
}

export class OpenCounter {
  open = 0;
  /** Body reads served, to prove a reader stops early. */
  reads = 0;
}

type Step = Uint8Array | "hang";

class ScriptedBody implements ResponseBody {
  constructor(
    private readonly steps: readonly Step[],
    private readonly counter: OpenCounter,
  ) {}

  getReader(): BodyReader {
    let i = 0;
    let live = true;
    let wake: (() => void) | undefined;
    const end = (): void => {
      if (live) {
        live = false;
        this.counter.open -= 1;
      }
      wake?.();
    };
    this.counter.open += 1;
    return {
      read: async () => {
        if (!live) return { done: true };
        this.counter.reads += 1;
        const step = this.steps[i++];
        if (step === undefined) {
          end();
          return { done: true };
        }
        if (step === "hang") {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          return { done: true };
        }
        return { done: false, value: step };
      },
      cancel: async () => end(),
      releaseLock: () => undefined,
    };
  }
}

const enc = new TextEncoder();

/** Split text into chunks of `size` bytes, so tests exercise chunk boundaries. */
export function chunkBytes(text: string, size: number): Uint8Array[] {
  const bytes = enc.encode(text);
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) out.push(bytes.slice(i, i + size));
  return out;
}

export function response(
  counter: OpenCounter,
  status: number,
  steps: readonly Step[],
  headers: Record<string, string> = {},
  extra: { redirected?: boolean; url?: string; type?: string } = {},
): ResponseLike {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    headers: { get: (name: string) => h.get(name.toLowerCase()) ?? null },
    body: new ScriptedBody(steps, counter),
    ...extra,
  };
}

export function jsonResponse(counter: OpenCounter, status: number, value: unknown, headers: Record<string, string> = {}): ResponseLike {
  return response(counter, status, [enc.encode(typeof value === "string" ? value : JSON.stringify(value))], { "content-type": "application/json", ...headers });
}

/** An SSE event as text. */
export function sseEvent(type: string, data: unknown): string {
  return `event: ${type}\ndata: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;
}

export function sseResponse(counter: OpenCounter, text: string, chunk = 16, tail: readonly Step[] = []): ResponseLike {
  return response(counter, 200, [...chunkBytes(text, chunk), ...tail], { "content-type": "text/event-stream" });
}

export type Handler = (call: RecordedCall, counter: OpenCounter) => ResponseLike | Promise<ResponseLike>;

export interface FakeFetch {
  readonly fetch: FetchLike;
  readonly calls: RecordedCall[];
  readonly counter: OpenCounter;
}

export function fakeFetch(handler: Handler): FakeFetch {
  const calls: RecordedCall[] = [];
  const counter = new OpenCounter();
  const fetch: FetchLike = async (url, init) => {
    const call = { url, init };
    calls.push(call);
    if (init.signal.aborted) throw new DOMExceptionLike();
    return handler(call, counter);
  };
  return { fetch, calls, counter };
}

class DOMExceptionLike extends Error {
  override readonly name = "AbortError";
}

/** A full, well-formed text reply as Anthropic would stream it. */
export function textReply(text: string, opts: { stopReason?: string; usageIn?: number; model?: string; split?: number } = {}): string {
  const split = opts.split ?? 4;
  let out = sseEvent("message_start", {
    type: "message_start",
    message: { id: "msg_test_1", type: "message", role: "assistant", model: opts.model ?? "test-model", content: [], usage: { input_tokens: opts.usageIn ?? 12, output_tokens: 1 } },
  });
  out += sseEvent("ping", { type: "ping" });
  out += sseEvent("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  for (let i = 0; i < text.length; i += split) {
    out += sseEvent("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: text.slice(i, i + split) } });
  }
  out += sseEvent("content_block_stop", { type: "content_block_stop", index: 0 });
  out += sseEvent("message_delta", { type: "message_delta", delta: { stop_reason: opts.stopReason ?? "end_turn", stop_sequence: null }, usage: { output_tokens: Math.max(1, Math.ceil(text.length / 4)) } });
  out += sseEvent("message_stop", { type: "message_stop" });
  return out;
}

export function modelInfo(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "model",
    id,
    display_name: "Test model",
    max_input_tokens: 200_000,
    max_tokens: 64_000,
    capabilities: { image_input: { supported: false } },
    ...extra,
  };
}
