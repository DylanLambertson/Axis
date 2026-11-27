// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { z } from "zod";
import { challengeReferenceSchema } from "./challenge.js";
import { guarded } from "./guard.js";
import { pluginIdSchema } from "./messages-wire.js";
import { projectIdSchema, type MethodSpec } from "./worktrees.js";

/**
 * `axis.plugins/1` (PV-K2, `docs/design/plugin-grant-contract.md` sections 2 to 4): the user's view of the plugins of a project,
 * the two decreases `revoke` and `disable` (tier 2, K2-g1), and the two increases `grant` and `enable` (tier 4: a daemon challenge
 * and main's native confirmation, K2-g2). Every method is the user's alone (a user policy row, never a web client, never a
 * plugin: `axis.plugins/` is on the plugin deny list). The increases are served but switched off until K2-enable: the host
 * refuses them before any challenge unless its `pluginGrants` option is on, and it is off in production.
 */
export const PLUGINS_CONTRACT = "axis.plugins" as const;
export const PLUGINS_VERSION = 1 as const;

/** The closed permission set of ADR 0008 decision 6 (journal v16 `PLUGIN_PERMISSIONS`; a daemon-host test keeps the two equal). */
export const PLUGIN_PERMISSION_NAMES = Object.freeze(["agents.read", "messages.send", "tasks.read", "tasks.write", "pages.read", "pages.write", "runs.start", "files.read"] as const);
export const pluginPermissionSchema = z.enum(PLUGIN_PERMISSION_NAMES);
/** At most this many plugins in one project (journal v16). */
export const MAX_PROJECT_PLUGINS = 64;

const pluginId = pluginIdSchema.max(64);

/** One plugin in one project: its switch, the generation that challenges bind to, and its granted permissions, sorted. */
export const projectPluginSchema = z.strictObject({
  pluginId,
  enabled: z.boolean(),
  generation: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  permissions: z
    .array(pluginPermissionSchema)
    .max(PLUGIN_PERMISSION_NAMES.length)
    .refine((ps) => ps.every((p, i) => i === 0 || (ps[i - 1] as string) < p), "permissions are sorted and unique"),
});
export type ProjectPlugin = z.infer<typeof projectPluginSchema>;

// list (read, tier 0)
export const pluginsListRequestSchema = guarded(z.strictObject({ projectId: projectIdSchema }));
export const pluginsListResponseSchema = guarded(
  z.strictObject({
    plugins: z
      .array(projectPluginSchema)
      .max(MAX_PROJECT_PLUGINS)
      .refine((ps) => new Set(ps.map((p) => p.pluginId)).size === ps.length, "duplicate plugin id"),
  }),
);

// revoke (write, tier 2): one permission; the plugin's generation grows by one and its open challenges end
export const pluginsRevokeRequestSchema = guarded(z.strictObject({ projectId: projectIdSchema, pluginId, permission: pluginPermissionSchema }));
// disable (write, tier 2): the switch off; the grants are kept; a plugin already off is answered as it is, unchanged
export const pluginsDisableRequestSchema = guarded(z.strictObject({ projectId: projectIdSchema, pluginId }));
export const pluginsChangeResponseSchema = guarded(z.strictObject({ plugin: projectPluginSchema }));
// grant (write, tier 4): one permission of the closed set; the retry that spends the approval carries `approval`
export const pluginsGrantRequestSchema = guarded(z.strictObject({ projectId: projectIdSchema, pluginId, permission: pluginPermissionSchema, approval: challengeReferenceSchema.optional() }));
// enable (write, tier 4): the switch on; the grants kept by a disable apply again
export const pluginsEnableRequestSchema = guarded(z.strictObject({ projectId: projectIdSchema, pluginId, approval: challengeReferenceSchema.optional() }));

export const pluginsMethods = {
  list: { request: pluginsListRequestSchema, response: pluginsListResponseSchema, sideEffect: "read", tier: 0, idempotency: "none", timeoutMs: 5_000 },
  revoke: { request: pluginsRevokeRequestSchema, response: pluginsChangeResponseSchema, sideEffect: "write", tier: 2, idempotency: "required", timeoutMs: 10_000 },
  disable: { request: pluginsDisableRequestSchema, response: pluginsChangeResponseSchema, sideEffect: "write", tier: 2, idempotency: "required", timeoutMs: 10_000 },
  // Tier 4: the approval is single use, so no idempotency key (as the pages tier-4 methods).
  grant: { request: pluginsGrantRequestSchema, response: pluginsChangeResponseSchema, sideEffect: "write", tier: 4, idempotency: "none", timeoutMs: 30_000 },
  enable: { request: pluginsEnableRequestSchema, response: pluginsChangeResponseSchema, sideEffect: "write", tier: 4, idempotency: "none", timeoutMs: 30_000 },
} as const satisfies Record<string, MethodSpec>;

export type PluginsMethod = keyof typeof pluginsMethods;
export type PluginsRequest<M extends PluginsMethod> = z.infer<(typeof pluginsMethods)[M]["request"]>;
export type PluginsResponse<M extends PluginsMethod> = z.infer<(typeof pluginsMethods)[M]["response"]>;
