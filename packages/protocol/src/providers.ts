// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { z } from "zod";
import { emptyRequestSchema, guarded, safeTextSchema } from "./guard.js";
import type { MethodSpec } from "./worktrees.js";

/**
 * `axis.providers/1`, list only (docs/design/daemon-host.md section 4.2).
 *
 * Read only and without any credential: it names the registered adapters, the
 * connection each is bound to and where its requests go (PRV-4), so the UI can
 * show them. Models, capabilities and connection checks are later methods; no
 * method here makes a network request.
 */

export const PROVIDERS_CONTRACT = "axis.providers" as const;
export const PROVIDERS_VERSION = 1 as const;

export const MAX_PROVIDERS = 64;

export const providerInfoSchema = z.strictObject({
  /** Stable adapter id such as `anthropic` or `mock` (the pattern `@axis/providers` enforces). */
  providerId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  displayName: safeTextSchema(80),
  /** Version of the provider adapter API the adapter implements. */
  apiVersion: z.number().int().min(1).max(1_000),
  /** The vault connection this adapter instance is bound to: an id, never a credential. */
  connectionId: safeTextSchema(256),
  destination: z.strictObject({
    /** Fixed network origin (scheme, host, optional port), or absent for an adapter that makes no request. */
    origin: z.string().max(300).regex(/^https?:\/\/[A-Za-z0-9.-]{1,253}(?::\d{1,5})?$/).optional(),
    description: safeTextSchema(256),
  }),
});
export type ProviderInfo = z.infer<typeof providerInfoSchema>;

// list (read, tier 0)
export const providersListRequestSchema = emptyRequestSchema;
export const providersListResponseSchema = guarded(
  z.strictObject({
    providers: z
      .array(providerInfoSchema)
      .max(MAX_PROVIDERS)
      .refine((ps) => new Set(ps.map((p) => p.connectionId)).size === ps.length, "duplicate connection id"),
  }),
);

export const providersMethods = {
  list: {
    request: providersListRequestSchema,
    response: providersListResponseSchema,
    sideEffect: "read",
    tier: 0,
    idempotency: "none",
    timeoutMs: 10_000,
  },
} as const satisfies Record<string, MethodSpec>;

export type ProvidersMethod = keyof typeof providersMethods;
export type ProvidersRequest<M extends ProvidersMethod> = z.infer<(typeof providersMethods)[M]["request"]>;
export type ProvidersResponse<M extends ProvidersMethod> = z.infer<(typeof providersMethods)[M]["response"]>;
