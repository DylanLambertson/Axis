// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { z } from "zod";
import { challengeReferenceSchema } from "./challenge.js";
import { guarded, safeTextSchema } from "./guard.js";
import {
  MAX_INTEGRATIONS, MAX_OPERATIONS, MAX_ORIGINS, MAX_SCOPES, argsSchema, integrationIdSchema, netBodySchema, netPathSchema,
  netReadMethodSchema, okStatusSchema, operationIdSchema, originSchema, resultValueSchema, scopeSchema,
} from "./integrations-wire.js";
import { projectIdSchema, type MethodSpec } from "./worktrees.js";

/*
 * `axis.integrations/1` and `axis.net/1` (ticket PV-N1a, `docs/design/integrations-contract.md`, ADR 0009 decisions 1 to 4).
* Planned contracts: the agreed schemas, served by PV-N1f (integrations) and PV-N1f with PV-K1 (net). A request names an
 * integration and one operation of its closed set with typed arguments, or an origin, a composed path and a method; there is
 * no URL, header, cookie, redirect, proxy or credential field in any request, and no reply carries a credential, a header or
 * a `Location` (ADR 0003 D7). The daemon composes the request, attaches the credential after the final URL pattern check
 * and builds every error from a fixed string.
 */
export const INTEGRATIONS_CONTRACT = "axis.integrations" as const;
export const INTEGRATIONS_VERSION = 1 as const;
export const NET_CONTRACT = "axis.net" as const;
export const NET_VERSION = 1 as const;

export const INTEGRATION_LABEL_CHARS = 64;

/** Where an integration stands for this project. `connecting`: a device flow is running (it ends within 15 minutes, ADR 0009 decision 6). */
export const INTEGRATION_STATES = ["available", "connecting", "connected", "needs_reconnect"] as const;
export const integrationStateSchema = z.enum(INTEGRATION_STATES);

/** One operation a connector offers; `write` operations are their own permission and a tier-3 challenge (D-10). */
export const operationSummarySchema = z.strictObject({ operation: operationIdSchema, write: z.boolean() });

/**
 * What the user may see of an integration: no token, no refresh token, no URL beyond its declared origins (punycode), and the
 * scopes by name. The granted scopes are empty unless connected.
 */
export const integrationSchema = z.strictObject({
  id: integrationIdSchema,
  label: safeTextSchema(INTEGRATION_LABEL_CHARS),
  origins: z.array(originSchema).min(1).max(MAX_ORIGINS),
  operations: z.array(operationSummarySchema).max(MAX_OPERATIONS),
  declaredScopes: z.array(scopeSchema).max(MAX_SCOPES),
  grantedScopes: z.array(scopeSchema).max(MAX_SCOPES),
  state: integrationStateSchema,
});
export type Integration = z.infer<typeof integrationSchema>;

// ---- axis.integrations/1 ----

export const integrationsListRequestSchema = z.strictObject({ projectId: projectIdSchema });
export const integrationsListResponseSchema = z.strictObject({ integrations: z.array(integrationSchema).max(MAX_INTEGRATIONS) });
export const integrationsStatusRequestSchema = z.strictObject({ projectId: projectIdSchema, integrationId: integrationIdSchema });
export const integrationsStatusResponseSchema = z.strictObject({ integration: integrationSchema });
/**
 * Start the device-code flow (the user's, from a built-in surface only). The reply is at once, with `connecting`; the code
 * and the verification host are shown by main in its own dialog (ADR 0009 decision 6), never returned here. The result is
 * read with `status`.
 */
export const integrationsConnectRequestSchema = z.strictObject({
  projectId: projectIdSchema,
  integrationId: integrationIdSchema,
  approval: challengeReferenceSchema.optional(),
});
export const integrationsConnectResponseSchema = z.strictObject({ integration: integrationSchema, changed: z.boolean() });
export const integrationsDisconnectRequestSchema = z.strictObject({ projectId: projectIdSchema, integrationId: integrationIdSchema });
export const integrationsDisconnectResponseSchema = z.strictObject({ integration: integrationSchema, changed: z.boolean() });
/**
 * A read operation of an integration's closed set (a `GET` or `HEAD`) with typed arguments, at tier 0. The daemon refuses an
 * operation that is a write here (`operation_kind_mismatch`). The answer is the connector's typed result of a successful
 * response, never a header.
 */
export const integrationsReadRequestSchema = z.strictObject({
  projectId: projectIdSchema,
  integrationId: integrationIdSchema,
  operation: operationIdSchema,
  args: argsSchema.optional(),
});
export const integrationsReadResponseSchema = z.strictObject({ status: okStatusSchema, result: resultValueSchema });
/**
 * A write operation (a `POST`, `PUT`, `PATCH` or `DELETE` of the connector): its own permission and a tier-3 challenge that
 * shows the integration, the operation and the exact values sent (D-10), whose `approval` the retry carries. The envelope's
 * idempotency key is required by the method, so a retried write never repeats at the service. The daemon refuses a read
 * operation here (`operation_kind_mismatch`).
 */
export const integrationsWriteRequestSchema = z.strictObject({
  projectId: projectIdSchema,
  integrationId: integrationIdSchema,
  operation: operationIdSchema,
  args: argsSchema.optional(),
  approval: challengeReferenceSchema.optional(),
});
export const integrationsWriteResponseSchema = integrationsReadResponseSchema;

// ---- axis.net/1 ----

/**
 * A plugin's read of a `net:<origin>` it was granted: an origin, a composed path with its query, `GET` or `HEAD`. Tier 0 and
 * subject to the per-plugin request and byte budget (threat model 4a OI-9). No credential, cookie or authorization header is
 * ever attached.
 */
export const netReadRequestSchema = z.strictObject({
  projectId: projectIdSchema,
  origin: originSchema,
  path: netPathSchema,
  method: netReadMethodSchema,
});
export const netReadResponseSchema = z.strictObject({ status: okStatusSchema, body: resultValueSchema });
/**
 * A plugin's `POST` to a granted `net:<origin>` with an optional JSON object body (sent as `application/json`): tier 3 with
 * the optional `approval` of its challenge, and the envelope's idempotency key required. It sends data out, so it is a
 * network method like any other.
 */
export const netSendRequestSchema = z.strictObject({
  projectId: projectIdSchema,
  origin: originSchema,
  path: netPathSchema,
  body: netBodySchema.optional(),
  approval: challengeReferenceSchema.optional(),
});
export const netSendResponseSchema = netReadResponseSchema;

/**
 * The closed refusals of both contracts: every error a handler returns other than `E_INTERNAL` and `E_CANCELLED` is one of
 * these, with `details: { reason }` and the one fixed message, so no argument, host, body or `Location` reaches an error.
 * `E_POLICY_DENIED` stays the pipeline's (permission and actor). The `E_UNAVAILABLE` reasons are what the egress client
 * names (ADR 0009 decision 4); an upstream failure carries no status text, body or header.
 */
export const INTEGRATIONS_REFUSALS = {
  E_NOT_FOUND: ["not_found"],
  E_INVALID_ARGUMENT: ["argument_refused", "origin_refused", "path_refused", "request_too_large", "operation_kind_mismatch"],
  E_CONFLICT: ["not_connected", "needs_reconnect", "already_connecting", "scope_refused", "busy", "audit_unavailable"],
  E_UNAVAILABLE: [
    "network_unavailable", "address_refused", "redirect_refused", "response_too_large", "response_depth_exceeded", "headers_too_large",
    "encoding_refused", "response_invalid", "upstream_status", "credential_echoed", "rate_limited",
  ],
  E_TIMEOUT: ["timeout"],
} as const;
export type IntegrationsRefusalCode = keyof typeof INTEGRATIONS_REFUSALS;
export const INTEGRATIONS_REASONS = Object.values(INTEGRATIONS_REFUSALS).flat();
export const integrationsRefusalDetailsSchema = z.strictObject({ reason: z.enum(INTEGRATIONS_REASONS as [string, ...string[]]) });
export const INTEGRATIONS_REFUSAL_MESSAGE = "integration request refused";

export function isIntegrationsRefusal(code: string, reason: string): boolean {
  return Object.hasOwn(INTEGRATIONS_REFUSALS, code) && (INTEGRATIONS_REFUSALS[code as IntegrationsRefusalCode] as readonly string[]).includes(reason);
}

const spec = <Req extends z.ZodType, Res extends z.ZodType>(
  request: Req,
  response: Res,
  sideEffect: "read" | "write" | "credential" | "network",
  tier: 0 | 1 | 3,
  idempotency: "none" | "required",
  timeoutMs: number,
) => ({ request: guarded(request), response: guarded(response), sideEffect, tier, idempotency, timeoutMs }) as const;

/**
 * Tiers are facts of the table, not promises of a handler. Reads 0. `connect` stores a credential: `credential`, tier 3 (the
 * main-built dialog of ADR 0009 decision 6 is its confirmation). `disconnect` only lowers privilege: a write at 1. A
 * request that sends caller data to an external host and changes something there is a `network` method at tier 3 with a
 * REQUIRED idempotency key and an optional `approval` (`integrations.write`, `net.send`); the read of a `GET` or `HEAD`
 * is tier 0 (`integrations.read`, `net.read`). A plugin's row may raise a tier, never lower it (ADR 0008 decision 6). The
 * timeouts: the egress client's own 10 s to first byte and 30 s total sit inside the 30 s envelope ceiling.
 */
export const integrationsMethods = {
  list: spec(integrationsListRequestSchema, integrationsListResponseSchema, "read", 0, "none", 5_000),
  status: spec(integrationsStatusRequestSchema, integrationsStatusResponseSchema, "read", 0, "none", 5_000),
  connect: spec(integrationsConnectRequestSchema, integrationsConnectResponseSchema, "credential", 3, "none", 10_000),
  disconnect: spec(integrationsDisconnectRequestSchema, integrationsDisconnectResponseSchema, "write", 1, "none", 10_000),
  read: spec(integrationsReadRequestSchema, integrationsReadResponseSchema, "read", 0, "none", 30_000),
  write: spec(integrationsWriteRequestSchema, integrationsWriteResponseSchema, "network", 3, "required", 30_000),
} as const satisfies Record<string, MethodSpec>;

export const netMethods = {
  read: spec(netReadRequestSchema, netReadResponseSchema, "read", 0, "none", 30_000),
  send: spec(netSendRequestSchema, netSendResponseSchema, "network", 3, "required", 30_000),
} as const satisfies Record<string, MethodSpec>;

export type IntegrationsMethod = keyof typeof integrationsMethods;
export type IntegrationsRequest<M extends IntegrationsMethod> = z.infer<(typeof integrationsMethods)[M]["request"]>;
export type IntegrationsResponse<M extends IntegrationsMethod> = z.infer<(typeof integrationsMethods)[M]["response"]>;
export type NetMethod = keyof typeof netMethods;
export type NetRequest<M extends NetMethod> = z.infer<(typeof netMethods)[M]["request"]>;
export type NetResponse<M extends NetMethod> = z.infer<(typeof netMethods)[M]["response"]>;
