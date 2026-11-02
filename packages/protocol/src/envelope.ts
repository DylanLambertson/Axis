// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { z } from "zod";
import { errorSchema } from "./errors.js";
import {
  contractIdSchema,
  contractVersionSchema,
  protocolVersionSchema,
} from "./version.js";

/** Hard ceilings. The daemon's byte-size and depth checks run before these schemas. */
export const MAX_TIMEOUT_MS = 30_000;
export const MAX_ID_LENGTH = 64;

/** Request id: caller-chosen, unique per connection. */
export const requestIdSchema = z.string().min(1).max(MAX_ID_LENGTH);
/** Idempotency key: UUIDv4 (ADR 0003 D3). */
export const idempotencyKeySchema = z.uuid({ version: "v4" });

export const methodNameSchema = z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,63}$/);

/**
 * A request. The payload is validated again by the method's own schema.
 * Identity fields (actor, workspace, connection) are not part of the
 * envelope and are never read from it: identity is bound to the port.
 */
export const requestEnvelopeSchema = z.strictObject({
  v: protocolVersionSchema,
  id: requestIdSchema,
  contract: contractIdSchema,
  contractVersion: contractVersionSchema,
  method: methodNameSchema,
  idempotencyKey: idempotencyKeySchema.optional(),
  /** Client wish; the server uses the smaller of this and the method ceiling. */
  timeoutMs: z.number().int().min(1).max(MAX_TIMEOUT_MS).optional(),
  payload: z.json(),
});
export type RequestEnvelope = z.infer<typeof requestEnvelopeSchema>;

/** Cooperative cancellation of an in-flight request. */
export const cancelEnvelopeSchema = z.strictObject({
  v: protocolVersionSchema,
  cancel: requestIdSchema,
});
export type CancelEnvelope = z.infer<typeof cancelEnvelopeSchema>;

export const okResponseSchema = z.strictObject({
  v: protocolVersionSchema,
  id: requestIdSchema,
  ok: z.literal(true),
  result: z.json(),
});
export const errorResponseSchema = z.strictObject({
  v: protocolVersionSchema,
  id: requestIdSchema,
  ok: z.literal(false),
  error: errorSchema,
});
export const responseEnvelopeSchema = z.discriminatedUnion("ok", [
  okResponseSchema,
  errorResponseSchema,
]);
export type ResponseEnvelope = z.infer<typeof responseEnvelopeSchema>;

/** First message on a new port, client to daemon. */
export const helloSchema = z.strictObject({
  type: z.literal("hello"),
  protocolVersions: z.array(protocolVersionSchema).min(1).max(16),
  contracts: z
    .array(
      z.strictObject({
        id: contractIdSchema,
        versions: z.array(contractVersionSchema).min(1).max(16),
      }),
    )
    .max(64),
});
export type Hello = z.infer<typeof helloSchema>;

/** Daemon's answer. `contracts` lists the single selected version of each shared contract. */
export const welcomeSchema = z.strictObject({
  type: z.literal("welcome"),
  protocolVersion: protocolVersionSchema,
  contracts: z
    .array(z.strictObject({ id: contractIdSchema, version: contractVersionSchema }))
    .max(64),
  limits: z.strictObject({
    maxMessageBytes: z.number().int().positive(),
    maxInFlight: z.number().int().positive(),
    maxTimeoutMs: z.number().int().positive().max(MAX_TIMEOUT_MS),
  }),
});
export type Welcome = z.infer<typeof welcomeSchema>;

/** Answer to `hello` when no common version exists. */
export const helloRejectedSchema = z.strictObject({
  type: z.literal("hello-rejected"),
  error: errorSchema,
});

export const clientMessageSchema = z.union([requestEnvelopeSchema, cancelEnvelopeSchema]);

/** Keys that are never accepted anywhere in a message (ADR 0003 D2.4). */
export const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);
export const MAX_MESSAGE_DEPTH = 16;

/**
 * Walk a decoded message and return the first violation, or null.
 * Zod strict objects do not flag an own `__proto__` key, so the daemon runs
 * this (with its byte-size check) before any schema. Iterative, so a deeply
 * nested message cannot overflow the stack.
 */
export function findForbiddenKey(
  value: unknown,
  maxDepth: number = MAX_MESSAGE_DEPTH,
): { reason: "forbidden-key" | "too-deep"; key?: string } | null {
  const stack: Array<[unknown, number]> = [[value, 0]];
  while (stack.length > 0) {
    const [node, depth] = stack.pop() as [unknown, number];
    if (typeof node !== "object" || node === null) continue;
    if (depth > maxDepth) return { reason: "too-deep" };
    if (Array.isArray(node)) {
      for (const item of node) stack.push([item, depth + 1]);
      continue;
    }
    for (const key of Object.getOwnPropertyNames(node)) {
      if (FORBIDDEN_KEYS.has(key)) return { reason: "forbidden-key", key };
      stack.push([(node as Record<string, unknown>)[key], depth + 1]);
    }
  }
  return null;
}

export type ParsedClientMessage =
  | { ok: true; message: z.infer<typeof clientMessageSchema> }
  | { ok: false; reason: "forbidden-key" | "too-deep" | "invalid" };

/**
 * The entry point the daemon uses for every decoded client message: the
 * forbidden-key and depth check runs first, then the envelope schema. The
 * daemon MUST NOT call `clientMessageSchema` directly (ADR 0005 D2).
 */
export function parseClientMessage(raw: unknown): ParsedClientMessage {
  const violation = findForbiddenKey(raw);
  if (violation !== null) return { ok: false, reason: violation.reason };
  const parsed = clientMessageSchema.safeParse(raw);
  return parsed.success ? { ok: true, message: parsed.data } : { ok: false, reason: "invalid" };
}
