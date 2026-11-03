// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { inspectMessage, type JsonValue } from "@axis/protocol";
import { ProviderError } from "./errors.js";
import {
  streamEventSchema,
  type GenerateResult,
  type StopReason,
  type StreamEvent,
  type TextBlock,
  type ToolUseBlock,
  type Usage,
} from "./types.js";

/** Defence-in-depth caps on one response, applied on top of adapter wire caps (ANT-1). */
export interface StreamLimits {
  readonly maxEvents?: number;
  /** UTF-16 units across all text deltas. */
  readonly maxTextChars?: number;
  /** UTF-16 units of partial JSON for one tool_use block. */
  readonly maxToolInputChars?: number;
  /** UTF-16 units across all text and tool input in one response (S8). */
  readonly maxResponseChars?: number;
}

export const DEFAULT_STREAM_LIMITS: Required<StreamLimits> = {
  maxEvents: 200_000,
  maxTextChars: 8_000_000,
  maxToolInputChars: 1_000_000,
  maxResponseChars: 16_000_000,
};

interface OpenBlock {
  readonly kind: "text" | "tool_use";
  readonly id?: string;
  readonly name?: string;
  parts: string[];
  chars: number;
  done: boolean;
  /** Tool input, parsed once at `content_block_stop`; `parts` is released then (S8, N6). */
  input?: JsonValue;
}

/** `undefined` means the default; anything else must be a positive safe integer (S7). */
function resolveLimits(limits: StreamLimits): Required<StreamLimits> {
  const out = { ...DEFAULT_STREAM_LIMITS };
  for (const key of Object.keys(DEFAULT_STREAM_LIMITS) as Array<keyof StreamLimits>) {
    const v: unknown = limits[key];
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1) {
      throw new RangeError(`stream limit ${key} must be a positive safe integer`);
    }
    out[key] = v;
  }
  return out;
}

function violation(reason: string): ProviderError {
  return new ProviderError("invalid_response", { reason });
}

/**
 * Checks events against the stream grammar (`streamEventSchema`) and the
 * limits, and assembles the result. Throws `invalid_response` with a fixed
 * reason word on the first violation; never echoes event content.
 */
export class StreamValidator {
  private readonly limits: Required<StreamLimits>;
  private events = 0;
  private textChars = 0;
  private responseChars = 0;
  private readonly toolIds = new Set<string>();
  private started = false;
  private stopped = false;
  private id: string | undefined;
  private model = "";
  private readonly blocks: OpenBlock[] = [];
  private lastUsage: Usage | undefined;
  private stopReason: StopReason | undefined;

  constructor(limits: StreamLimits = {}) {
    this.limits = resolveLimits(limits);
  }

  /** Usage seen so far (from `usage` or `message_stop`), for budget accounting on failure. */
  get usage(): Usage | undefined {
    return this.lastUsage;
  }

  get complete(): boolean {
    return this.stopped;
  }

  /** Validate one event; returns the parsed event (a fresh object, not the adapter's). */
  accept(raw: unknown): StreamEvent {
    if (++this.events > this.limits.maxEvents) throw violation("too_many_events");
    if (this.stopped) throw violation("event_after_stop");
    const parsed = streamEventSchema.safeParse(raw);
    if (!parsed.success) throw violation("malformed_event");
    const ev = parsed.data;
    if (!this.started && ev.type !== "message_start") throw violation("missing_message_start");

    switch (ev.type) {
      case "message_start":
        if (this.started) throw violation("duplicate_message_start");
        this.started = true;
        this.id = ev.id;
        this.model = ev.model;
        break;
      case "content_block_start": {
        if (ev.index !== this.blocks.length) throw violation("block_index_order");
        if (ev.block.type === "tool_use") {
          // The broker keys approvals and results by tool-use id (ANT-2, N6).
          if (this.toolIds.has(ev.block.id)) throw violation("duplicate_tool_use_id");
          this.toolIds.add(ev.block.id);
        }
        this.blocks.push(
          ev.block.type === "text"
            ? { kind: "text", parts: [], chars: 0, done: false }
            : { kind: "tool_use", id: ev.block.id, name: ev.block.name, parts: [], chars: 0, done: false },
        );
        break;
      }
      case "content_block_delta": {
        const b = this.blocks[ev.index];
        if (b === undefined || b.done) throw violation("delta_outside_block");
        if (ev.delta.type === "text") {
          if (b.kind !== "text") throw violation("delta_type_mismatch");
          this.textChars += ev.delta.text.length;
          this.responseChars += ev.delta.text.length;
          if (this.textChars > this.limits.maxTextChars) throw violation("text_too_large");
          if (this.responseChars > this.limits.maxResponseChars) throw violation("response_too_large");
          b.parts.push(ev.delta.text);
        } else {
          if (b.kind !== "tool_use") throw violation("delta_type_mismatch");
          b.chars += ev.delta.partialJson.length;
          this.responseChars += ev.delta.partialJson.length;
          if (b.chars > this.limits.maxToolInputChars) throw violation("tool_input_too_large");
          if (this.responseChars > this.limits.maxResponseChars) throw violation("response_too_large");
          b.parts.push(ev.delta.partialJson);
        }
        break;
      }
      case "content_block_stop": {
        const b = this.blocks[ev.index];
        if (b === undefined || b.done) throw violation("stop_outside_block");
        b.done = true;
        if (b.kind === "tool_use") {
          b.input = parseToolInput(b.parts.join(""));
          b.parts = [];
        }
        break;
      }
      case "usage":
        this.checkUsage(ev.usage);
        break;
      case "message_stop":
        if (this.blocks.some((b) => !b.done)) throw violation("unclosed_block");
        if (ev.stopReason === "tool_use" && !this.blocks.some((b) => b.kind === "tool_use")) {
          throw violation("tool_use_stop_without_tool");
        }
        this.checkUsage(ev.usage);
        this.stopReason = ev.stopReason;
        this.stopped = true;
        break;
    }
    return ev;
  }

  /** Usage is cumulative: no counter may go down, cache counters included (N6). */
  private checkUsage(u: Usage): void {
    const prev = this.lastUsage;
    if (prev !== undefined) {
      const down =
        u.inputTokens < prev.inputTokens ||
        u.outputTokens < prev.outputTokens ||
        (u.cacheReadTokens ?? 0) < (prev.cacheReadTokens ?? 0) ||
        (u.cacheWriteTokens ?? 0) < (prev.cacheWriteTokens ?? 0);
      if (down) throw violation("usage_decreased");
    }
    this.lastUsage = u;
  }

  /** The assembled result. Throws if the stream did not end with `message_stop`. */
  result(): GenerateResult {
    if (!this.stopped || this.stopReason === undefined || this.lastUsage === undefined) throw violation("truncated_stream");
    const content: Array<TextBlock | ToolUseBlock> = this.blocks.map((b) =>
      b.kind === "text"
        ? { type: "text", text: b.parts.join("") }
        : { type: "tool_use", id: b.id as string, name: b.name as string, input: structuredClone(b.input as JsonValue) },
    );
    const base = { model: this.model, content, stopReason: this.stopReason, usage: this.lastUsage };
    return this.id === undefined ? base : { ...base, id: this.id };
  }
}

/** Tool input must be one bounded JSON object (an empty stream of deltas means `{}`). */
function parseToolInput(text: string): JsonValue {
  if (text.trim() === "") return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw violation("tool_input_not_json");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw violation("tool_input_not_object");
  if (!inspectMessage(value).ok) throw violation("tool_input_unbounded");
  return value as JsonValue;
}

/** Drain a stream through a validator and return the assembled result. */
export async function collectStream(events: AsyncIterable<unknown>, limits?: StreamLimits): Promise<GenerateResult> {
  const v = new StreamValidator(limits);
  for await (const ev of events) v.accept(ev);
  return v.result();
}
