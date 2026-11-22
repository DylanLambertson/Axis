// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { z } from "zod";
import { CREDENTIAL_BACKENDS, CREDENTIAL_PROTECTIONS } from "@axis/protocol";

/**
 * The secret broker's control messages (ticket PV-N0a, `docs/design/secret-broker.md` §3.4): the daemon asks main, over the
 * private control channel (ADR 0003 D1.6), to read and write credential records main keeps in `<base>/secrets`. No renderer can
 * send or read them. Requests go host → supervisor; each answer is one `secrets.result` with the same `requestId`. Closed
 * errors only: no exception text, path or value ever crosses.
 */

const requestId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

/**
 * An entry name: the vault's rule (a provider id, or `integration:` and an id under the same rule; ADR 0009 decision 5), at most
 * 100 characters (§3.1). Restated here because neither this file nor main may import `@axis/vault`.
 */
export const SECRET_NAME_RE = /^(?:integration:)?[a-z0-9][a-z0-9._-]{0,63}$/;
export const SECRET_NAME_MAX = 100;
export const secretNameSchema = z.string().max(SECRET_NAME_MAX).regex(SECRET_NAME_RE);

/** The vault's secret rule: 8 to 4,096 printable ASCII characters, no whitespace (so the record frame parses unambiguously). */
export const secretValueSchema = z.string().regex(/^[\x21-\x7e]{8,4096}$/);

/** The vault's `EntryMeta`, strict. */
export const secretMetaSchema = z.strictObject({
  label: z.string().min(1).max(64).regex(/^[\x20-\x7e]+$/).optional(),
  storedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  backend: z.enum(CREDENTIAL_BACKENDS),
  protection: z.enum(CREDENTIAL_PROTECTIONS),
  weakConsent: z.boolean(),
});
export type SecretMeta = z.infer<typeof secretMetaSchema>;

const where = z.strictObject({ backend: z.enum(CREDENTIAL_BACKENDS), protection: z.enum(CREDENTIAL_PROTECTIONS) });

export const SECRETS_REQUEST_TYPES = ["secrets.info", "secrets.put", "secrets.get", "secrets.meta", "secrets.remove", "secrets.list"] as const;

export const secretsInfoSchema = z.strictObject({ type: z.literal("secrets.info"), requestId });
export const secretsPutSchema = z.strictObject({ type: z.literal("secrets.put"), requestId, name: secretNameSchema, secret: secretValueSchema, meta: secretMetaSchema });
export const secretsGetSchema = z.strictObject({ type: z.literal("secrets.get"), requestId, name: secretNameSchema });
export const secretsMetaSchema = z.strictObject({ type: z.literal("secrets.meta"), requestId, name: secretNameSchema });
export const secretsRemoveSchema = z.strictObject({ type: z.literal("secrets.remove"), requestId, name: secretNameSchema });
export const secretsListSchema = z.strictObject({ type: z.literal("secrets.list"), requestId });

/** Every request the host sends main (outbound). */
export const secretsRequestSchemas = [secretsInfoSchema, secretsPutSchema, secretsGetSchema, secretsMetaSchema, secretsRemoveSchema, secretsListSchema] as const;
export const secretsRequestSchema = z.discriminatedUnion("type", [...secretsRequestSchemas]);
export type SecretsRequest = z.infer<typeof secretsRequestSchema>;

/** The closed errors (§3.4). */
export const SECRETS_ERRORS = ["not_found", "refused", "corrupt", "failed"] as const;
export type SecretsError = (typeof SECRETS_ERRORS)[number];

/** At most 256 entries (§3.1). */
export const MAX_SECRET_ENTRIES = 256;

const okInfo = z.strictObject({ op: z.literal("info"), backend: z.enum(CREDENTIAL_BACKENDS), protection: z.enum(CREDENTIAL_PROTECTIONS), available: z.boolean() });
const okPut = z.strictObject({ op: z.literal("put"), landedOn: where });
const okGet = z.strictObject({ op: z.literal("get"), secret: secretValueSchema, meta: secretMetaSchema });
const okMeta = z.strictObject({ op: z.literal("meta"), meta: secretMetaSchema });
const okRemove = z.strictObject({ op: z.literal("remove"), removed: z.boolean() });
const okList = z.strictObject({ op: z.literal("list"), entries: z.array(z.strictObject({ name: secretNameSchema, meta: secretMetaSchema })).max(MAX_SECRET_ENTRIES) });

/**
 * Main's answer (inbound): one value of the request's kind, or one closed error, never both. One object (not a union) so it
 * joins the inbound discriminated union under its `type`.
 */
export const secretsResultSchema = z
  .strictObject({
    type: z.literal("secrets.result"),
    requestId,
    ok: z.boolean(),
    value: z.discriminatedUnion("op", [okInfo, okPut, okGet, okMeta, okRemove, okList]).optional(),
    error: z.enum(SECRETS_ERRORS).optional(),
  })
  .refine((m) => (m.ok ? m.value !== undefined && m.error === undefined : m.value === undefined && m.error !== undefined));
export type SecretsResult = z.infer<typeof secretsResultSchema>;
export type SecretsValue = NonNullable<SecretsResult["value"]>;
