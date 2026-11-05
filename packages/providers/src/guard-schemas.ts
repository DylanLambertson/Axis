// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { z } from "zod";
import { MAX_LISTED_MODELS } from "./guard-types.js";
import { PROVIDER_ADAPTER_API_VERSION, modelIdSchema } from "./types.js";

/** The adapter descriptor, checked once by `guardProvider` (R1). */
export const descriptorSchema = z.object({
  apiVersion: z.literal(PROVIDER_ADAPTER_API_VERSION),
  providerId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  displayName: z.string().min(1).max(128),
  connectionId: z.string().min(1).max(256),
  destination: z.object({
    origin: z
      .string()
      .max(256)
      .refine((o) => {
        try {
          const u = new URL(o);
          return u.protocol === "https:" && u.origin === o;
        } catch {
          return false;
        }
      }, "an https origin")
      .optional(),
    description: z.string().min(1).max(512),
  }),
});

export const listedModelsSchema = z
  .array(z.object({ id: modelIdSchema, displayName: z.string().max(256).optional() }))
  .max(MAX_LISTED_MODELS);

export const tokenCountSchema = z.object({ inputTokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) });
