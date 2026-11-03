// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { z } from "zod";
import type { Identity } from "./types.js";

const id = z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/);

/** What a verifier may hand back. A buggy verifier must not be able to put a malformed actor into audit. */
export const identitySchema = z.strictObject({
  connectionId: id,
  windowId: id,
  actorId: id,
  actor: z.union([z.literal("user"), z.literal("daemon"), z.string().regex(/^agent:[A-Za-z0-9._-]{1,64}$/)]),
  workspaceId: id.optional(),
  trusted: z.boolean(),
  clientKind: z.enum(["desktop", "web"]),
});

export function parseIdentity(value: unknown): Identity | undefined {
  const r = identitySchema.safeParse(value);
  return r.success ? (r.data as Identity) : undefined;
}
