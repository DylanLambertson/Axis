// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { z } from "zod";
import { ProviderError, type ProviderErrorCode, type StopReason, type StreamEvent, type Usage } from "@axis/providers";
import type { EventCounters } from "./sse.js";

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const usageSchema = z.object({
  input_tokens: count.nullish(),
  output_tokens: count.nullish(),
  cache_read_input_tokens: count.nullish(),
  cache_creation_input_tokens: count.nullish(),
});

const typeOnly = z.object({ type: z.string() });
const messageStart = z.object({
  message: z.object({ id: z.string().min(1).max(256).nullish(), model: z.string(), usage: usageSchema.nullish() }),
});
const blockStart = z.object({
  index: z.number().int().min(0).max(4_095),
  content_block: z.object({
    type: z.string(),
    id: z.string().optional(),
    name: z.string().optional(),
    text: z.string().nullish(),
    input: z.unknown().optional(),
  }),
});
const blockDelta = z.object({
  index: z.number().int().min(0).max(4_095),
  delta: z.object({ type: z.string(), text: z.string().optional(), partial_json: z.string().optional() }),
});
const blockStop = z.object({ index: z.number().int().min(0).max(4_095) });
const messageDelta = z.object({
  delta: z.object({ stop_reason: z.string().nullish() }).nullish(),
  usage: usageSchema.nullish(),
});
const errorEvent = z.object({ error: z.object({ type: z.string().optional() }).nullish() });

/** Blocks, mapped or ignored, that one response may open. */
const MAX_WIRE_BLOCKS = 4_096;

/** The stream `error` event types and what they mean. The message text is never used. */
export function codeForErrorType(type: string | undefined): ProviderErrorCode {
  switch (type) {
    case "overloaded_error":
      return "overloaded";
    case "rate_limit_error":
      return "rate_limited";
    case "invalid_request_error":
      return "invalid_request";
    case "authentication_error":
      return "authentication";
    case "billing_error":
    case "permission_error":
      return "permission_denied";
    case "not_found_error":
      return "not_found";
    case "request_too_large":
      return "context_length_exceeded";
    case "timeout_error":
      return "timeout";
    default:
      return "server_error";
  }
}

function mapStopReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case "end_turn":
    case "max_tokens":
    case "stop_sequence":
    case "tool_use":
    case "refusal":
      return reason;
    default:
      return "other";
  }
}

function malformed(): ProviderError {
  return new ProviderError("invalid_response", { reason: "malformed_event" });
}

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const r = schema.safeParse(value);
  if (!r.success) throw malformed();
  return r.data;
}

/**
 * Maps Anthropic stream events to normalized ones. Wire block indices count
 * every block, mapped or ignored; the normalized grammar needs 0, 1, 2 … in
 * start order, so they are remapped here. Anything unknown is ignored and
 * counted, never executed.
 */
export class EventMapper {
  private readonly mapped = new Map<number, number>();
  private readonly ignoredBlocks = new Set<number>();
  private nextIndex = 0;
  private started = false;
  private stopped = false;
  private stop: StopReason | undefined;
  private inputTokens = 0;
  private outputTokens = 0;
  private cacheRead: number | undefined;
  private cacheWrite: number | undefined;

  constructor(private readonly counters: EventCounters) {}

  /** True once `message_stop` has been mapped. */
  get finished(): boolean {
    return this.stopped;
  }

  private usage(): Usage {
    return {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      ...(this.cacheRead === undefined ? {} : { cacheReadTokens: this.cacheRead }),
      ...(this.cacheWrite === undefined ? {} : { cacheWriteTokens: this.cacheWrite }),
    };
  }

  /** Cumulative counters; take the running maximum so a later event cannot make usage go down. Returns true if any rose. */
  private absorb(u: z.infer<typeof usageSchema> | null | undefined): boolean {
    if (u === null || u === undefined) return false;
    let changed = false;
    if (typeof u.input_tokens === "number" && u.input_tokens > this.inputTokens) (this.inputTokens = u.input_tokens), (changed = true);
    if (typeof u.output_tokens === "number" && u.output_tokens > this.outputTokens) (this.outputTokens = u.output_tokens), (changed = true);
    if (typeof u.cache_read_input_tokens === "number" && u.cache_read_input_tokens > (this.cacheRead ?? -1)) {
      this.cacheRead = u.cache_read_input_tokens;
      changed = true;
    }
    if (typeof u.cache_creation_input_tokens === "number" && u.cache_creation_input_tokens > (this.cacheWrite ?? -1)) {
      this.cacheWrite = u.cache_creation_input_tokens;
      changed = true;
    }
    return changed;
  }

  /** Map one parsed event JSON value. May throw a `ProviderError`. */
  map(json: unknown): StreamEvent[] {
    if (this.stopped) throw new ProviderError("invalid_response", { reason: "event_after_stop" });
    const head = typeOnly.safeParse(json);
    if (!head.success) throw malformed();
    switch (head.data.type) {
      case "message_start": {
        if (this.started) throw new ProviderError("invalid_response", { reason: "duplicate_message_start" });
        const m = parse(messageStart, json).message;
        this.started = true;
        this.absorb(m.usage);
        return [
          { type: "message_start", ...(m.id === null || m.id === undefined ? {} : { id: m.id }), model: m.model },
          // Input usage right away, so a cancelled request is charged for what was sent.
          { type: "usage", usage: this.usage() },
        ];
      }
      case "content_block_start": {
        const e = parse(blockStart, json);
        if (this.mapped.has(e.index) || this.ignoredBlocks.has(e.index)) throw new ProviderError("invalid_response", { reason: "duplicate_block_index" });
        if (this.mapped.size + this.ignoredBlocks.size >= MAX_WIRE_BLOCKS) throw new ProviderError("invalid_response", { reason: "too_many_blocks" });
        const b = e.content_block;
        if (b.type === "text") {
          const index = this.nextIndex++;
          this.mapped.set(e.index, index);
          const out: StreamEvent[] = [{ type: "content_block_start", index, block: { type: "text" } }];
          if (typeof b.text === "string" && b.text !== "") out.push({ type: "content_block_delta", index, delta: { type: "text", text: b.text } });
          return out;
        }
        if (b.type === "tool_use") {
          if (b.id === undefined || b.name === undefined) throw malformed();
          const empty = typeof b.input === "object" && b.input !== null && !Array.isArray(b.input) && Object.keys(b.input).length === 0;
          if (b.input !== undefined && !empty) throw new ProviderError("invalid_response", { reason: "unexpected_tool_input" });
          const index = this.nextIndex++;
          this.mapped.set(e.index, index);
          return [{ type: "content_block_start", index, block: { type: "tool_use", id: b.id, name: b.name } }];
        }
        this.counters.countIgnored();
        this.ignoredBlocks.add(e.index);
        return [];
      }
      case "content_block_delta": {
        const e = parse(blockDelta, json);
        const index = this.mapped.get(e.index);
        if (index === undefined) {
          // Thinking and other ignored blocks can stream many deltas; they count as raw events only.
          if (this.ignoredBlocks.has(e.index)) return [];
          throw new ProviderError("invalid_response", { reason: "delta_outside_block" });
        }
        if (e.delta.type === "text_delta" && typeof e.delta.text === "string") {
          return [{ type: "content_block_delta", index, delta: { type: "text", text: e.delta.text } }];
        }
        if (e.delta.type === "input_json_delta" && typeof e.delta.partial_json === "string") {
          return [{ type: "content_block_delta", index, delta: { type: "tool_input", partialJson: e.delta.partial_json } }];
        }
        if (e.delta.type === "text_delta" || e.delta.type === "input_json_delta") throw malformed();
        this.counters.countIgnored();
        return [];
      }
      case "content_block_stop": {
        const e = parse(blockStop, json);
        const index = this.mapped.get(e.index);
        if (index === undefined) {
          if (this.ignoredBlocks.has(e.index)) return [];
          throw new ProviderError("invalid_response", { reason: "stop_outside_block" });
        }
        return [{ type: "content_block_stop", index }];
      }
      case "message_delta": {
        const e = parse(messageDelta, json);
        const reason = e.delta?.stop_reason;
        if (typeof reason === "string") this.stop = mapStopReason(reason);
        return this.absorb(e.usage) ? [{ type: "usage", usage: this.usage() }] : [];
      }
      case "message_stop":
        this.stopped = true;
        return [{ type: "message_stop", stopReason: this.stop ?? "other", usage: this.usage() }];
      case "ping":
        this.counters.countIgnored();
        return [];
      case "error": {
        const e = parse(errorEvent, json);
        // The error message is never used: only the type, through a fixed table.
        throw new ProviderError(codeForErrorType(e.error?.type));
      }
      default:
        this.counters.countIgnored();
        return [];
    }
  }
}
