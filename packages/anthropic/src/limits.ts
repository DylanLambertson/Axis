// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

/** The one origin this adapter talks to. There is no option to change it (PRV-5 is not shipped). */
export const ANTHROPIC_ORIGIN = "https://api.anthropic.com";
/** The pinned `anthropic-version` header value; also the `providerApiVersion` of capability reports. */
export const ANTHROPIC_VERSION = "2023-06-01";

/** Wire limits (ANT-1). Defaults are in `DEFAULT_LIMITS`; tests lower them rather than building huge bodies. */
export interface AnthropicLimits {
  /** One SSE line, in bytes. */
  readonly maxLineBytes: number;
  /** All `data:` lines of one SSE event, in bytes. */
  readonly maxEventBytes: number;
  /** The whole response body, in bytes. */
  readonly maxStreamBytes: number;
  readonly maxRawEvents: number;
  /** Pings, comments, unknown event types, unknown block and delta types. */
  readonly maxIgnoredEvents: number;
  /** Nesting of one event's JSON. */
  readonly maxEventJsonDepth: number;
  /** A small JSON response (models, token count). */
  readonly maxJsonBodyBytes: number;
  /** The part of an error body that is read at all. */
  readonly maxErrorBodyBytes: number;
  /** The serialized request. */
  readonly maxRequestBytes: number;
}

export const DEFAULT_LIMITS: AnthropicLimits = {
  maxLineBytes: 1_048_576,
  maxEventBytes: 1_048_576,
  maxStreamBytes: 67_108_864,
  maxRawEvents: 500_000,
  maxIgnoredEvents: 10_000,
  maxEventJsonDepth: 12,
  maxJsonBodyBytes: 4_194_304,
  maxErrorBodyBytes: 16_384,
  maxRequestBytes: 33_554_432,
};

/** `undefined` keeps the default; anything else must be a positive safe integer. */
export function resolveLimits(overrides: Partial<AnthropicLimits> = {}): AnthropicLimits {
  const out: { -readonly [K in keyof AnthropicLimits]: AnthropicLimits[K] } = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(DEFAULT_LIMITS) as Array<keyof AnthropicLimits>) {
    const v: unknown = overrides[key];
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1) throw new RangeError(`limit ${key} must be a positive safe integer`);
    out[key] = v;
  }
  return out;
}

export const MAX_MODEL_PAGES = 5;
export const MAX_LISTED_MODELS = 1_000;
export const CAPABILITY_TTL_MS = 600_000;
export const MAX_CACHED_CAPABILITIES = 64;
