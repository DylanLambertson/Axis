// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { z } from "zod";
import { emptyRequestSchema, guarded, safeTextSchema } from "./guard.js";
import type { MethodSpec } from "./worktrees.js";

/**
 * `axis.providers/1`, list only (docs/design/daemon-host.md on branch docs/daemon-host-design, section 4.2).
 *
 * Read only and without any credential: it names the registered adapters, the
 * connection each is bound to and where its requests go (PRV-4), so the UI can
 * show them, with the models each connection offers (C5). Capabilities and
 * connection checks are later methods. The list asks each adapter for its model
 * list, so an adapter that lists over the network does so to the destination it
 * shows here and to no other; a connection that cannot list is `unavailable`.
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
/** A vault connection name (never a credential or a URL); `axis.runs/1` request events use it too. */
export const connectionNameSchema = z.string().regex(CONNECTION_NAME);
/** Where a provider request goes, as one line of display text (PRV-4): an https origin or the adapter's own description. */
export const destinationTextSchema = safeTextSchema(512).refine((t) => sanitizeDestinationText(t) === t, "no credentials, query or fragment in a URL");

/**
 * A URL inside destination text without its userinfo, query and fragment (`https://u:pw@host/p?x=1#f` becomes
 * `https://host/p`). Producers apply it before the text reaches this contract, which refuses text it would still change.
 */
export function sanitizeDestinationText(text: string): string {
  return text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]*@/gi, "$1").replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s?#]*)[?#]\S*/gi, "$1");
}

export const MAX_MODELS_PER_PROVIDER = 200;
/** A model id as the list shows it: a short, closed alphabet (no space, slash, quote or URL), so it cannot carry a URL with a password. */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const providerModelSchema = z.strictObject({
  modelId: z.string().regex(MODEL_ID),
  displayName: safeTextSchema(128).optional(),
});
export type ProviderModel = z.infer<typeof providerModelSchema>;

/** `new URL(o).origin === o`: the same https-origin rule `@axis/providers` applies. */
const isHttpsOrigin = (o: string): boolean => {
  try {
    const u = new URL(o);
    return u.protocol === "https:" && u.origin === o;
  } catch {
    return false;
  }
};

export const providerInfoSchema = z
  .strictObject({
    /** Stable adapter id such as `anthropic` or `mock` (the pattern `@axis/providers` enforces). */
    providerId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    displayName: safeTextSchema(128),
    /** Version of the provider adapter API the adapter implements. */
    apiVersion: z.number().int().min(1).max(1_000),
    /** The vault connection this adapter instance is bound to: a name, never a credential. */
    connectionId: connectionNameSchema,
    /**
     * `ready`: the connection's models are listed. `unavailable`: they could not be listed (it could not be reached,
     * was too slow, or answered something this contract refuses); a run on it is refused and nothing falls back to
     * another provider or connection (PRV-4). `unchecked`: the adapter sends requests over the network, so this
     * read-only list does not ask it (no unapproved outbound request per list call) and no model list has been
     * recorded yet. `models` is empty unless `ready`.
     */
    status: z.enum(["ready", "unavailable", "unchecked"]),
    /** The models this connection offers, by model id. Empty unless `ready`. */
    models: z
      .array(providerModelSchema)
      .max(MAX_MODELS_PER_PROVIDER)
      .refine((ms) => new Set(ms.map((m) => m.modelId)).size === ms.length, "duplicate model id"),
    destination: z.strictObject({
      /** Fixed https origin (scheme, host, optional port), or absent for an adapter that makes no request. */
      origin: z.string().max(256).refine(isHttpsOrigin, "an https origin").optional(),
      description: destinationTextSchema,
    }),
  })
  .refine((p) => p.status === "ready" || p.models.length === 0, "models only on a ready connection");
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
