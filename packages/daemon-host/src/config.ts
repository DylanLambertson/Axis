// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { isAbsolute } from "node:path";
import { types } from "node:util";
import { z } from "zod";
import { AxisError } from "@axis/audit";
import { contractIdSchema } from "@axis/protocol";

/**
 * `HostConfig`: the one `init` message the supervisor sends (design section 3, step 2). The data directory and the
 * key come from the supervisor, never from a renderer message or an environment variable. Every object is strict:
 * an unknown key, including `__proto__`, refuses the whole message.
 */

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
export const PLATFORMS = ["darwin", "linux", "win32"] as const;

/** At least 32 random bytes (design step 2), at most 96. */
export const ATTESTATION_KEY_MIN_BYTES = 32;
export const ATTESTATION_KEY_MAX_BYTES = 96;
/** A key with fewer distinct byte values than this is not random (32 random bytes have about 30). */
const MIN_DISTINCT_KEY_BYTES = 16;
const MAX_PATH_CHARS = 4096;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

const pathSchema = z
  .string()
  .min(1)
  .max(MAX_PATH_CHARS)
  .refine((p) => !p.includes("\0") && isAbsolute(p), "absolute path required");

/** The key as base64url text on the wire (no padding); parsed into bytes. */
const attestationKeySchema = z
  .string()
  .max(Math.ceil((ATTESTATION_KEY_MAX_BYTES * 4) / 3))
  .refine((s) => BASE64URL.test(s), "base64url required")
  .transform((s, ctx) => {
    const bytes = Buffer.from(s, "base64url");
    // Round trip: refuses non-canonical text (stray trailing bits), which Buffer accepts silently.
    if (bytes.toString("base64url") !== s) {
      ctx.addIssue({ code: "custom", message: "base64url required" });
      return z.NEVER;
    }
    if (bytes.length < ATTESTATION_KEY_MIN_BYTES || bytes.length > ATTESTATION_KEY_MAX_BYTES) {
      ctx.addIssue({ code: "custom", message: "key length" });
      return z.NEVER;
    }
    if (new Set(bytes).size < MIN_DISTINCT_KEY_BYTES) {
      ctx.addIssue({ code: "custom", message: "key is not random" });
      return z.NEVER;
    }
    return new Uint8Array(bytes);
  });

const boundedInt = (min: number, max: number) => z.number().int().min(min).max(max);

/** Overrides of the host's built-in limits. Tests lower them; a missing key keeps the built-in default. */
export const limitsSchema = z.strictObject({
  maxConnections: boundedInt(1, 1024).optional(),
  connectsPerMinute: boundedInt(1, 600).optional(),
  connectBurst: boundedInt(1, 100).optional(),
  logQueueSize: boundedInt(16, 10_000).optional(),
  reconcileBudgetMs: boundedInt(1_000, 120_000).optional(),
  anchorMaxLagEvents: boundedInt(1, 100_000).optional(),
  anchorMaxAgeMs: boundedInt(1_000, 3_600_000).optional(),
});
export type HostLimits = z.infer<typeof limitsSchema>;

export const hostConfigSchema = z
  .strictObject({
    dataDir: pathSchema,
    worktreeRoot: pathSchema,
    platform: z.enum(PLATFORMS),
    logLevel: z.enum(LOG_LEVELS).default("info"),
    /** False when packaged. */
    devDiagnostics: z.boolean().default(false),
    /** Test supervisors only: allow the in-memory idempotency store (design step 8). Needs `devDiagnostics`. */
    devMemoryIdempotency: z.boolean().default(false),
    attestationKey: attestationKeySchema,
    /** Allow-list of contract ids to serve. Absent means every contract the protocol registry holds. */
    contracts: z
      .array(contractIdSchema)
      .max(32)
      .refine((a) => new Set(a).size === a.length, "duplicate contract")
      .optional(),
    limits: limitsSchema.default({}),
  })
  .refine((c) => !c.devMemoryIdempotency || c.devDiagnostics, "devMemoryIdempotency needs devDiagnostics");

export type HostConfig = Readonly<z.infer<typeof hostConfigSchema>>;

const MAX_REPORT_CHARS = 512;
const SAFE_PATH_SEGMENT = /^[A-Za-z][A-Za-z0-9]{0,31}$/;

/** `path:code` pairs from a validation failure. Never a message and never a value: those can echo the key. */
function describeIssues(error: z.ZodError): string {
  const parts: string[] = [];
  for (const issue of error.issues.slice(0, 8)) {
    // A key name is client text. Only a plain identifier is kept; anything else is reported as `?`.
    const path = issue.path.map((p) => (typeof p === "string" && SAFE_PATH_SEGMENT.test(p) ? p : "?")).join(".");
    parts.push(`${path === "" ? "(root)" : path}:${issue.code}`);
  }
  return parts.join(";").slice(0, MAX_REPORT_CHARS);
}

function invalid(issues: string): AxisError {
  return new AxisError("E_INVALID_ARGUMENT", "The host configuration is invalid", { reason: "invalid_config", issues });
}

/**
 * Parse the `init` payload. Throws `AxisError` `E_INVALID_ARGUMENT` (exit code 78) whose detail lists the failing
 * paths and issue codes only. The input is not modified, a `Proxy` is refused unread, and the result is frozen.
 */
export function parseHostConfig(input: unknown): HostConfig {
  if (typeof input !== "object" || input === null || Array.isArray(input) || types.isProxy(input)) {
    throw invalid("(root):invalid_type");
  }
  let result: ReturnType<typeof hostConfigSchema.safeParse>;
  try {
    result = hostConfigSchema.safeParse(input);
  } catch {
    // A getter that throws, or any other hostile input the schema could not read.
    throw invalid("(root):unreadable");
  }
  if (!result.success) throw invalid(describeIssues(result.error));
  const c = result.data;
  return Object.freeze({ ...c, limits: Object.freeze({ ...c.limits }) });
}
