// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { z } from "zod";
import { REFUSED_DISPLAY } from "./display.js";
import { inspectMessage, type InspectLimits } from "./limits.js";

/**
 * The one message every guarded schema reports. It is a constant on purpose:
 * Zod's own issues name unknown keys and can carry other input-derived text,
 * so none of them is ever passed on (no schema here echoes its input).
 */
export const INVALID_PAYLOAD_MESSAGE = "invalid payload";

type Copy = { readonly ok: true; readonly value: unknown } | { readonly ok: false };

/**
 * A plain structured copy of `raw`, or `{ ok: false }`. The bounded walk runs
 * first (accessors, irregular arrays, forbidden keys, aliasing, limits), then
 * `structuredClone`, which throws on a Proxy and on anything else the walk
 * could not see through. Nothing thrown is kept or reported.
 */
export function copyBounded(raw: unknown, limits?: InspectLimits): Copy {
  try {
    if (!inspectMessage(raw, limits).ok) return { ok: false };
    return { ok: true, value: structuredClone(raw) };
  } catch {
    return { ok: false };
  }
}

type Guarded<S extends z.ZodType> = z.ZodPipe<z.ZodUnknown, z.ZodTransform<z.output<S>, unknown>>;

/**
 * Wrap a strict schema so it can be called directly on hostile input. The
 * input is inspected and copied first (`copyBounded`), the strict schema only
 * ever sees the copy, and the result is the parsed copy, never the caller's
 * object. A failure is one fixed issue with no path and no input text.
 *
 * `shape` is carried over so `@axis/daemon`'s "tier 3 and above declares an
 * optional `approval`" check still sees the fields of a guarded object.
 */
export function guarded<S extends z.ZodType>(inner: S): Guarded<S> {
  const schema: Guarded<S> = z.unknown().transform((raw, ctx): z.output<S> => {
    const copy = copyBounded(raw);
    if (copy.ok) {
      try {
        const parsed = inner.safeParse(copy.value);
        if (parsed.success) return parsed.data;
      } catch {
        // A throwing refinement is a rejection, never an escape.
      }
    }
    ctx.addIssue({ code: "custom", message: INVALID_PAYLOAD_MESSAGE });
    return z.NEVER;
  });
  const shape = (inner as { shape?: unknown }).shape;
  return shape === undefined ? schema : Object.assign(schema, { shape });
}

/** A strict object with no fields: the request of a method that takes nothing. */
export const emptyRequestSchema = guarded(z.strictObject({}));

/** UTC timestamp exactly as `Date.prototype.toISOString` writes it: a real date, not just the right shape. */
export const timestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine((t) => !Number.isNaN(Date.parse(t)) && new Date(t).toISOString() === t, "not a real date");

/** Non-negative safe integer (sequence numbers, counts, durations). */
export const countSchema = z.number().int().min(0);

/** A chain position: sequence number and SHA-256 hex. */
export const chainHeadSchema = z.strictObject({
  seq: z.number().int().min(1),
  hash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type ChainHead = z.infer<typeof chainHeadSchema>;

/** Short lower-case reason code such as `anchor_stalled`; never free text. */
export const reasonCodeSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);

/**
 * One line of display text: bounded, no leading or trailing whitespace, and no
 * control, format (bidi, zero-width) or line-separator characters.
 */
export const safeTextSchema = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((t) => t === t.trim() && !REFUSED_DISPLAY.test(t), {
      message: "no leading or trailing whitespace, no control or invisible characters",
    });

/**
 * Display text that is not edited by the schema: bounded, may be empty or have
 * edge spaces, but no control, format (bidi, zero-width), surrogate or
 * line-separator characters (the same set as `@axis/challenge` `displaySafe`).
 */
export const displayTextSchema = (max: number) =>
  z
    .string()
    .max(max)
    .refine((t) => !REFUSED_DISPLAY.test(t), { message: "no control or invisible characters" });
