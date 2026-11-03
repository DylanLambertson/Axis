// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { makeError, responseEnvelopeSchema, type AxisError, type ErrorCode, type JsonValue } from "@axis/protocol";

/**
 * Thrown by handlers to return a specific wire error.
 *
 * What reaches the wire is constrained by `toWireError`:
 * - `message` is a user-safe constant (or a template filled only from fields
 *   annotated public or path). It is at most `SAFE_MESSAGE_MAX` characters,
 *   holds no control characters and passes the secret-pattern scan; if any of
 *   that fails the message is replaced by a generic one.
 * - `details` keys must be on the per-code allowlist below with a bounded
 *   value; anything else drops the whole `details`.
 * - `E_APPROVAL_REQUIRED`, `E_POLICY_DENIED`, `E_UNAUTHENTICATED` and
 *   `E_VERSION_UNSUPPORTED` cannot be thrown by a handler (only the daemon
 *   decides them, with an audit row); they become `E_INTERNAL`.
 */
export class DaemonError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Readonly<Record<string, JsonValue>>,
  ) {
    super(message);
    this.name = "DaemonError";
  }
}

/** Codes that mean a daemon decision (audited elsewhere); a handler cannot claim one. */
const DAEMON_ONLY_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "E_APPROVAL_REQUIRED",
  "E_POLICY_DENIED",
  "E_UNAUTHENTICATED",
  "E_VERSION_UNSUPPORTED",
]);

export const SAFE_MESSAGE_MAX = 200;
const GENERIC_MESSAGE = "Request failed";

export const CONTROL_CHARS = /[\p{Cc}\p{Cf}\u2028\u2029]/u;

/** A second layer behind the contract rules: obvious credential shapes. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}/,
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}/,
  /\b(?:password|passwd|secret|token|api[_-]?key|authorization)\s*[:=]\s*\S{4,}/i,
  /[A-Za-z0-9+/_-]{40,}/,
];

/** True if the text contains a control character or looks like it carries a credential. */
export function looksUnsafe(text: string): boolean {
  return CONTROL_CHARS.test(text) || SECRET_PATTERNS.some((p) => p.test(text));
}

const MAX_DETAIL_STRING = 128;
type DetailRule = (value: JsonValue) => boolean;
const safeString: DetailRule = (v) => typeof v === "string" && v.length <= MAX_DETAIL_STRING && !looksUnsafe(v);
const safeStringList: DetailRule = (v) => Array.isArray(v) && v.length <= 8 && v.every(safeString);
const retryAfter: DetailRule = (v) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 3_600_000;

/** Which detail keys a handler may attach to which code. Codes not listed carry none. */
const DETAIL_ALLOWLIST: Readonly<Partial<Record<ErrorCode, Readonly<Record<string, DetailRule>>>>> = {
  E_INVALID_ARGUMENT: { fields: safeStringList, reason: safeString },
  E_NOT_FOUND: { reason: safeString },
  E_CONFLICT: { reason: safeString, retryAfterMs: retryAfter },
  E_BACKPRESSURE: { retryAfterMs: retryAfter },
  E_UNAVAILABLE: { reason: safeString, retryAfterMs: retryAfter },
  E_TIMEOUT: { retryAfterMs: retryAfter },
};

/** `undefined` for no details, `null` if the details break the rules. */
function constrainDetails(
  code: ErrorCode,
  details: Readonly<Record<string, JsonValue>> | undefined,
): Record<string, JsonValue> | undefined | null {
  if (details === undefined) return undefined;
  const allowed = DETAIL_ALLOWLIST[code] ?? {};
  const out: Record<string, JsonValue> = {};
  for (const key of Object.keys(details)) {
    const rule = Object.hasOwn(allowed, key) ? allowed[key] : undefined;
    const value = details[key] as JsonValue;
    if (rule === undefined || !rule(value)) return null;
    out[key] = value;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

/**
 * Handler-visible error policy: a `DaemonError` keeps its code and constrained
 * text; everything else, and the codes only the daemon may mint, is an opaque
 * `E_INTERNAL`. `onInternal` receives the raw error for local diagnostics only.
 */
export function toWireError(
  error: unknown,
  correlationId: string,
  version: number,
  onInternal: ((correlationId: string, error: unknown) => void) | undefined,
): AxisError {
  const internal = (): AxisError => makeError("E_INTERNAL", "Internal error", correlationId);
  if (!(error instanceof DaemonError)) {
    onInternal?.(correlationId, error);
    return internal();
  }
  if (DAEMON_ONLY_CODES.has(error.code)) {
    onInternal?.(correlationId, new Error(`a handler tried to raise ${error.code}`));
    return internal();
  }
  const details = constrainDetails(error.code, error.details);
  const messageOk = error.message.length > 0 && error.message.length <= SAFE_MESSAGE_MAX && !looksUnsafe(error.message);
  const wire = makeError(
    error.code,
    messageOk ? error.message : GENERIC_MESSAGE,
    correlationId,
    details === null || details === undefined ? undefined : details,
  );
  return responseEnvelopeSchema.safeParse({ v: version, id: "x", ok: false, error: wire }).success ? wire : internal();
}
