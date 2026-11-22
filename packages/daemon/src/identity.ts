// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { z } from "zod";
import type { Identity } from "./types.js";

const id = z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/);

/** A plugin id (ADR 0008 decision 3): `pluginIdSchema`'s form (lower-case dot-separated words), at most 64 characters in all. */
export const PLUGIN_ID_RE = /^(?=[a-z0-9.-]{1,64}$)[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*){0,3}$/;
/** The plugin actor: `plugin:` and a plugin id. */
export const PLUGIN_ACTOR_RE = /^plugin:(?=[a-z0-9.-]{1,64}$)[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*){0,3}$/;
/** A plugin view's window id (`p<n>`, main's counter) and a code window's (`w<n>`, `windowIdOf`). */
const PLUGIN_WINDOW_RE = /^p[0-9]{1,10}$/;
const CODE_WINDOW_RE = /^w[0-9]{1,10}$/;

/**
 * What a verifier may hand back. A buggy verifier must not be able to put a malformed actor into audit. A plugin identity
 * (ADR 0008 decision 3) is all of: actor `plugin:<id>`, `actorId` equal to it, `clientKind` `plugin`, a `p<n>` window, a
 * `w<n>` host window and a project; no other identity may carry a `p<n>` window or a host window.
 */
export const identitySchema = z
  .strictObject({
    /** Minted by main (ADR 0003: 128 random bits, 22+ base64url characters). A reusable id would let a new session replay a tier 4 result. */
    connectionId: z.string().regex(/^[A-Za-z0-9_-]{22,64}$/),
    windowId: id,
    /** A plugin's `actorId` is its actor (`plugin:` and up to 64 characters), longer than the generic id; the refinement below ties them. */
    actorId: z.union([id, z.string().regex(PLUGIN_ACTOR_RE)]),
    actor: z.union([z.literal("user"), z.literal("daemon"), z.string().regex(/^agent:[A-Za-z0-9._-]{1,64}$/), z.string().regex(PLUGIN_ACTOR_RE)]),
    workspaceId: id.optional(),
    trusted: z.boolean(),
    clientKind: z.enum(["desktop", "web", "plugin"]),
    hostWindowId: id.optional(),
  })
  .refine((v) => {
    const plugin = v.clientKind === "plugin";
    if (plugin !== v.actor.startsWith("plugin:")) return false;
    if (!plugin) return v.hostWindowId === undefined && !PLUGIN_WINDOW_RE.test(v.windowId) && !v.actorId.startsWith("plugin:");
    return v.actorId === v.actor && PLUGIN_WINDOW_RE.test(v.windowId) && v.hostWindowId !== undefined && CODE_WINDOW_RE.test(v.hostWindowId) && v.workspaceId !== undefined;
  });

export function parseIdentity(value: unknown): Identity | undefined {
  const r = identitySchema.safeParse(value);
  return r.success ? (r.data as Identity) : undefined;
}
