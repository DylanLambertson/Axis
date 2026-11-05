// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { z } from "zod";
import { emptyRequestSchema, guarded, safeTextSchema } from "./guard.js";
import type { MethodSpec } from "./worktrees.js";

/**
 * `axis.providers/1`, list only (docs/design/daemon-host.md on branch docs/daemon-host-design, section 4.2).
 *
 * Read only and without any credential: it names the registered adapters, the
 * connection each is bound to and where its requests go (PRV-4), so the UI can
 * show them. Models, capabilities and connection checks are later methods; no
 * method here makes a network request.
 */

export const PROVIDERS_CONTRACT = "axis.providers" as const;
export const PROVIDERS_VERSION = 1 as const;

export const MAX_PROVIDERS = 64;

/**
 * Length bounds follow `@axis/providers` (the descriptor `guardProvider`
 * checks): display name 1 to 128, description 1 to 512, origin a bare https
 * origin. The character rules are stricter, not looser (display text has no
 * edge whitespace and no control, bidi or zero-width characters), so an adapter
 * that passes `@axis/providers` can still make the whole list fail until it
 * adopts them (docs/packages.md, "Display text is held to rules").
 * The connection id is the one deliberate tightening: it must be a vault
 * connection name (`NAME_RE` in `@axis/vault`), never free text, so a
 * credential or a URL with a password in a wrongly wired adapter cannot reach
 * the renderer. `@axis/providers` accepts any 1 to 256 characters there and
 * should adopt this pattern.
 */
const CONNECTION_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** `new URL(o).origin === o`: the same https-origin rule `@axis/providers` applies. */
const isHttpsOrigin = (o: string): boolean => {
  try {
    const u = new URL(o);
    return u.protocol === "https:" && u.origin === o;
  } catch {
    return false;
  }
};

export const providerInfoSchema = z.strictObject({
  /** Stable adapter id such as `anthropic` or `mock` (the pattern `@axis/providers` enforces). */
  providerId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  displayName: safeTextSchema(128),
  /** Version of the provider adapter API the adapter implements. */
  apiVersion: z.number().int().min(1).max(1_000),
  /** The vault connection this adapter instance is bound to: a name, never a credential. */
  connectionId: z.string().regex(CONNECTION_NAME),
  destination: z.strictObject({
    /** Fixed https origin (scheme, host, optional port), or absent for an adapter that makes no request. */
    origin: z.string().max(256).refine(isHttpsOrigin, "an https origin").optional(),
    description: safeTextSchema(512),
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
