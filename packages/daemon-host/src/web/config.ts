// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { z } from "zod";
import { AxisError } from "@axis/audit";
import { MAX_MESSAGE_BYTES } from "@axis/protocol";
import { refuseNonPlainData } from "../inspect.js";

/**
 * The web host's opt-in configuration (ticket W1, `docs/design/web-host-entry.md`). There is no default: a caller that
 * has no configuration starts nothing, and this parse refuses everything but `enabled: true`. The listener binds to a
 * loopback IP literal only (no host name, no wildcard address); the allowed origins are exact serialized origins and
 * there must be at least one. Unknown keys are refused. A refusal names a closed reason, never a value.
 */

export const WEB_HOSTS = ["127.0.0.1", "::1"] as const;
export type WebHostAddress = (typeof WEB_HOSTS)[number];

export interface WebHostLimits {
  /** Live sessions at once (default 4, at most 16). */
  readonly maxClients: number;
  /** Largest WebSocket message payload in bytes (default and maximum: the protocol maximum). */
  readonly maxFrameBytes: number;
  /** Unsent bytes a session may hold toward its browser before it is closed (default 4 MiB). */
  readonly maxOutboundBytes: number;
  /** Supervisor channel messages not yet written at which every session stops reading (default 64). */
  readonly maxChannelBacklog: number;
}

export interface WebHostConfig {
  readonly enabled: true;
  readonly host: WebHostAddress;
  /** 0 picks a free port (the bound one is reported); otherwise 1024 to 65535. */
  readonly port: number;
  readonly allowedOrigins: readonly string[];
  readonly limits: WebHostLimits;
}

export const DEFAULT_WEB_LIMITS: WebHostLimits = Object.freeze({
  maxClients: 4,
  maxFrameBytes: MAX_MESSAGE_BYTES,
  maxOutboundBytes: 4 * 1024 * 1024,
  maxChannelBacklog: 64,
});

/** True for a serialized `http`/`https` origin: scheme, host and an optional non-default port; nothing else. */
export function isSerializedOrigin(text: string): boolean {
  if (text.length > 256 || text === "null") return false;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return false;
  }
  return (url.protocol === "http:" || url.protocol === "https:") && url.hostname !== "" && url.origin === text;
}

const originSchema = z.string().refine(isSerializedOrigin);

const limitsSchema = z.strictObject({
  maxClients: z.number().int().min(1).max(16).optional(),
  maxFrameBytes: z.number().int().min(1024).max(MAX_MESSAGE_BYTES).optional(),
  maxOutboundBytes: z.number().int().min(65_536).max(64 * 1024 * 1024).optional(),
  maxChannelBacklog: z.number().int().min(1).max(1024).optional(),
});

const configSchema = z.strictObject({
  enabled: z.literal(true),
  host: z.enum(WEB_HOSTS).optional(),
  port: z.number().int().refine((p) => p === 0 || (p >= 1024 && p <= 65_535)),
  allowedOrigins: z.array(originSchema).min(1).max(8),
  limits: limitsSchema.optional(),
});

const invalid = (): AxisError => new AxisError("E_INVALID_ARGUMENT", "Invalid web host configuration", { reason: "web_config_invalid" });

export function parseWebHostConfig(raw: unknown): WebHostConfig {
  if (refuseNonPlainData(raw, { maxBytes: 16_384 }) !== undefined) throw invalid();
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) throw invalid();
  const { host, port, allowedOrigins, limits } = parsed.data;
  if (new Set(allowedOrigins).size !== allowedOrigins.length) throw invalid();
  const resolved: WebHostLimits = Object.freeze({
    maxClients: limits?.maxClients ?? DEFAULT_WEB_LIMITS.maxClients,
    maxFrameBytes: limits?.maxFrameBytes ?? DEFAULT_WEB_LIMITS.maxFrameBytes,
    maxOutboundBytes: limits?.maxOutboundBytes ?? DEFAULT_WEB_LIMITS.maxOutboundBytes,
    maxChannelBacklog: limits?.maxChannelBacklog ?? DEFAULT_WEB_LIMITS.maxChannelBacklog,
  });
  return Object.freeze({ enabled: true, host: host ?? "127.0.0.1", port, allowedOrigins: Object.freeze([...allowedOrigins]), limits: resolved });
}
