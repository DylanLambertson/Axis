// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { z } from "zod";
import { errorSchema } from "./errors.js";
import { boundedJsonSchema, inspectMessage, type InspectFailure } from "./limits.js";
import {
  contractIdSchema,
  contractVersionSchema,
  protocolVersionSchema,
} from "./version.js";

/** Hard ceilings for one call. */
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
  payload: boundedJsonSchema,
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
  result: boundedJsonSchema,
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

const unique = (xs: readonly unknown[]): boolean => new Set(xs).size === xs.length;

/** First message on a new port, client to daemon. */
export const helloSchema = z.strictObject({
  type: z.literal("hello"),
  protocolVersions: z.array(protocolVersionSchema).min(1).max(16).refine(unique, "duplicate version"),
  contracts: z
    .array(
      z.strictObject({
        id: contractIdSchema,
        versions: z.array(contractVersionSchema).min(1).max(16).refine(unique, "duplicate version"),
      }),
    )
    .max(64)
    .refine((cs) => unique(cs.map((c) => c.id)), "duplicate contract"),
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

/** Every message a client may send: the first is `hello`, then requests and cancels. */
export const clientMessageSchema = z.union([helloSchema, requestEnvelopeSchema, cancelEnvelopeSchema]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

export type ParsedClientMessage =
  | { ok: true; message: ClientMessage }
  | { ok: false; reason: InspectFailure };

/**
 * The only entry point the daemon uses for a decoded client message
 * (`hello`, request and cancel alike): the bounded walk runs first, then the
 * envelope schema (ADR 0005 D2.5). Calling `clientMessageSchema` directly is a defect.
 */
export function parseClientMessage(raw: unknown): ParsedClientMessage {
  const checked = inspectMessage(raw);
  if (!checked.ok) return checked;
  const parsed = clientMessageSchema.safeParse(raw);
  return parsed.success ? { ok: true, message: parsed.data } : { ok: false, reason: "invalid" };
}
