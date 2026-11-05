// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { z } from "zod";
import { boundedJsonSchema, type JsonValue } from "@axis/protocol";
import type { ProviderError } from "./errors.js";

/**
 * Version of the adapter API in this file. An adapter declares the version it
 * implements in its descriptor; the guard refuses any other (PROVIDERS.md
 * "Version the adapter API").
 */
export const PROVIDER_ADAPTER_API_VERSION = 1;

// ---------------------------------------------------------------------------
// Bounds on a normalized request. Adapters may apply tighter wire limits.
// ---------------------------------------------------------------------------

export const MAX_MESSAGES = 2_048;
export const MAX_BLOCKS_PER_MESSAGE = 512;
export const MAX_TEXT_CHARS = 4_000_000;
export const MAX_TOOLS = 128;
export const MAX_STOP_SEQUENCES = 16;
export const MAX_OUTPUT_TOKENS = 1_000_000;
/** Base64 characters for one inline image (about 15 MiB decoded). */
export const MAX_IMAGE_BASE64_CHARS = 20_000_000;

const idSchema = z.string().min(1).max(256);
export const modelIdSchema = z.string().min(1).max(256).regex(/^[\x21-\x7e]+$/, "printable ASCII, no spaces");
export const toolNameSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

// ---------------------------------------------------------------------------
// Content and messages (normalized across providers).
// ---------------------------------------------------------------------------

export const textBlockSchema = z.strictObject({ type: z.literal("text"), text: z.string().max(MAX_TEXT_CHARS) });

export const imageBlockSchema = z.strictObject({
  type: z.literal("image"),
  mediaType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
  /** Base64 data. URLs are not accepted: a URL would make the provider fetch on our behalf. */
  data: z.string().min(1).max(MAX_IMAGE_BASE64_CHARS).regex(/^[A-Za-z0-9+/]+={0,2}$/),
});

/** A model's request to call a tool. `input` is untrusted model output (ANT-2). */
export const toolUseBlockSchema = z.strictObject({
  type: z.literal("tool_use"),
  id: idSchema,
  name: toolNameSchema,
  input: boundedJsonSchema,
});

export const toolResultBlockSchema = z.strictObject({
  type: z.literal("tool_result"),
  toolUseId: idSchema,
  content: z.union([z.string().max(MAX_TEXT_CHARS), z.array(textBlockSchema).max(MAX_BLOCKS_PER_MESSAGE)]),
  isError: z.boolean().optional(),
});

export const contentBlockSchema = z.discriminatedUnion("type", [
  textBlockSchema,
  imageBlockSchema,
  toolUseBlockSchema,
  toolResultBlockSchema,
]);

export const messageSchema = z.strictObject({
  role: z.enum(["user", "assistant"]),
  content: z.array(contentBlockSchema).min(1).max(MAX_BLOCKS_PER_MESSAGE),
});

export const toolDefinitionSchema = z.strictObject({
  name: toolNameSchema,
  description: z.string().max(16_384),
  /** JSON Schema for the tool input; passed to the provider as-is. */
  inputSchema: boundedJsonSchema,
});

export const toolChoiceSchema = z.union([
  z.enum(["auto", "any", "none"]),
  z.strictObject({ type: z.literal("tool"), name: toolNameSchema }),
]);

/**
 * A normalized generation request. `providerOptions` is the raw escape hatch
 * (PROVIDERS.md "raw provider escape hatches"): keyed by provider id, ignored
 * by every adapter except the named one, and scanned like the rest of the
 * request before it is sent.
 */
export const generateRequestSchema = z.strictObject({
  model: modelIdSchema,
  system: z.string().max(MAX_TEXT_CHARS).optional(),
  messages: z.array(messageSchema).min(1).max(MAX_MESSAGES),
  tools: z.array(toolDefinitionSchema).max(MAX_TOOLS).optional(),
  toolChoice: toolChoiceSchema.optional(),
  maxOutputTokens: z.number().int().min(1).max(MAX_OUTPUT_TOKENS),
  temperature: z.number().min(0).max(2).optional(),
  stopSequences: z.array(z.string().min(1).max(256)).max(MAX_STOP_SEQUENCES).optional(),
  providerOptions: z.record(z.string().min(1).max(64), boundedJsonSchema).optional(),
});

export type TextBlock = z.infer<typeof textBlockSchema>;
export type ImageBlock = z.infer<typeof imageBlockSchema>;
export type ToolUseBlock = z.infer<typeof toolUseBlockSchema>;
export type ToolResultBlock = z.infer<typeof toolResultBlockSchema>;
export type ContentBlock = z.infer<typeof contentBlockSchema>;
export type Message = z.infer<typeof messageSchema>;
export type ToolDefinition = z.infer<typeof toolDefinitionSchema>;
export type ToolChoice = z.infer<typeof toolChoiceSchema>;
export type GenerateRequest = z.input<typeof generateRequestSchema>;

// ---------------------------------------------------------------------------
// Results, usage and stream events.
// ---------------------------------------------------------------------------

export const STOP_REASONS = ["end_turn", "max_tokens", "stop_sequence", "tool_use", "refusal", "other"] as const;
export const stopReasonSchema = z.enum(STOP_REASONS);
export type StopReason = z.infer<typeof stopReasonSchema>;

const tokenCount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** Token usage for one request. Cumulative within a request. */
export const usageSchema = z.strictObject({
  inputTokens: tokenCount,
  outputTokens: tokenCount,
  cacheReadTokens: tokenCount.optional(),
  cacheWriteTokens: tokenCount.optional(),
});
export type Usage = z.infer<typeof usageSchema>;

export const ZERO_USAGE: Usage = Object.freeze({ inputTokens: 0, outputTokens: 0 });

export interface GenerateResult {
  readonly id?: string;
  readonly model: string;
  /** Text and tool_use blocks, in order. */
  readonly content: ReadonlyArray<TextBlock | ToolUseBlock>;
  readonly stopReason: StopReason;
  readonly usage: Usage;
}

/**
 * Stream events. A valid stream is exactly: one `message_start`; then any
 * number of `usage` events and content blocks (each `content_block_start`,
 * its deltas, `content_block_stop`; block indices 0, 1, 2 … in start order);
 * then one `message_stop` after every block has stopped. Errors are thrown
 * from the iterator as `ProviderError`, never sent as events.
 */
export const streamEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("message_start"), id: idSchema.optional(), model: modelIdSchema }),
  z.strictObject({
    type: z.literal("content_block_start"),
    index: z.number().int().min(0).max(MAX_BLOCKS_PER_MESSAGE - 1),
    block: z.discriminatedUnion("type", [
      z.strictObject({ type: z.literal("text") }),
      z.strictObject({ type: z.literal("tool_use"), id: idSchema, name: toolNameSchema }),
    ]),
  }),
  z.strictObject({
    type: z.literal("content_block_delta"),
    index: z.number().int().min(0).max(MAX_BLOCKS_PER_MESSAGE - 1),
    delta: z.discriminatedUnion("type", [
      z.strictObject({ type: z.literal("text"), text: z.string() }),
      z.strictObject({ type: z.literal("tool_input"), partialJson: z.string() }),
    ]),
  }),
  z.strictObject({ type: z.literal("content_block_stop"), index: z.number().int().min(0).max(MAX_BLOCKS_PER_MESSAGE - 1) }),
  z.strictObject({ type: z.literal("usage"), usage: usageSchema }),
  z.strictObject({ type: z.literal("message_stop"), stopReason: stopReasonSchema, usage: usageSchema }),
]);
export type StreamEvent = z.infer<typeof streamEventSchema>;

// ---------------------------------------------------------------------------
// Capabilities (per connection + model + provider API version).
// ---------------------------------------------------------------------------

/** `unknown` is shown as such in the UI and treated as unsupported when a request uses it. */
export const CAPABILITY_STATES = ["supported", "unsupported", "unknown"] as const;
export const capabilityStateSchema = z.enum(CAPABILITY_STATES);
export type CapabilityState = z.infer<typeof capabilityStateSchema>;

export const FEATURES = [
  "streaming",
  "systemPrompt",
  "toolUse",
  "parallelToolUse",
  "toolChoice",
  "imageInput",
  "stopSequences",
  "temperature",
  "structuredOutput",
  "reasoning",
  "promptCaching",
  "tokenCounting",
  "costEstimation",
] as const;
export type Feature = (typeof FEATURES)[number];

export const modelCapabilitiesSchema = z.strictObject({
  modelId: modelIdSchema,
  /** The provider API version the report applies to, for example a dated version header. */
  providerApiVersion: z.string().min(1).max(64),
  features: z.strictObject(
    Object.fromEntries(FEATURES.map((f) => [f, capabilityStateSchema])) as Record<Feature, typeof capabilityStateSchema>,
  ),
  limits: z.strictObject({
    contextWindowTokens: tokenCount.optional(),
    maxOutputTokens: tokenCount.optional(),
  }),
});
export type ModelCapabilities = z.infer<typeof modelCapabilitiesSchema>;

export interface ModelInfo {
  readonly id: string;
  readonly displayName?: string;
}

// ---------------------------------------------------------------------------
// The adapter.
// ---------------------------------------------------------------------------

/**
 * Where request data goes, shown to the user per request (PRV-4). `origin` is
 * the fixed network origin, or undefined for an adapter that makes no network
 * request (the mock).
 */
export interface Destination {
  readonly origin?: string;
  readonly description: string;
}

export interface AdapterDescriptor {
  readonly apiVersion: number;
  /** Stable provider id, for example `anthropic` or `mock`. */
  readonly providerId: string;
  readonly displayName: string;
  /** The connection this instance is bound to; one adapter instance per connection. */
  readonly connectionId: string;
  readonly destination: Destination;
}

export interface CallOptions {
  /** Required. Aborting it cancels the call; see the cancellation contract below. */
  readonly signal: AbortSignal;
}

export type ConnectionCheck = { readonly ok: true } | { readonly ok: false; readonly error: ProviderError };

export interface TokenCount {
  readonly inputTokens: number;
}

/** Cost in integer micro-USD, to avoid float drift in budgets. */
export interface CostEstimate {
  readonly microUsd: number;
}

/**
 * A provider adapter (PROVIDERS.md "SDK shape"). One instance per connection.
 *
 * Contract (checked by `@axis/providers/contract`):
 * - Every failure is a `ProviderError` from the taxonomy, with a user-safe
 *   message that never contains a credential, a request body or a provider
 *   response body.
 * - Requests are validated with `validateRequest` before anything is sent;
 *   a request using a feature the model does not report as `supported` fails
 *   with `unsupported_capability` and is never emulated.
 * - Cancellation: if `signal` is already aborted, the call fails with
 *   `cancelled` and makes no provider request. If it aborts later, the
 *   pending promise or the next `next()` fails with `cancelled` promptly, and
 *   the underlying request is released. Ending iteration early (`break`,
 *   `return()`) also releases it.
 * - `stream()` never throws synchronously; errors surface from iteration.
 * - Streams follow the event grammar on `streamEventSchema`.
 * - `generate()` returns what `collectStream()` would build from `stream()`.
 *
 * `cancel?` from PROVIDERS.md is replaced by `CallOptions.signal`.
 */
export interface ProviderAdapter {
  readonly descriptor: AdapterDescriptor;
  listModels(opts: CallOptions): Promise<readonly ModelInfo[]>;
  /** Fails with `not_found` for a model the connection does not offer. */
  getCapabilities(model: string, opts: CallOptions): Promise<ModelCapabilities>;
  /** Never throws for an expected failure such as a bad credential; returns it. */
  validateConnection(opts: CallOptions): Promise<ConnectionCheck>;
  generate(request: GenerateRequest, opts: CallOptions): Promise<GenerateResult>;
  stream(request: GenerateRequest, opts: CallOptions): AsyncIterable<StreamEvent>;
  countTokens?(request: GenerateRequest, opts: CallOptions): Promise<TokenCount>;
  /** Pure: no I/O. Undefined when the adapter has no price for the model. */
  estimateCost?(model: string, usage: Usage): CostEstimate | undefined;
}

export type { JsonValue };
