// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { types } from "node:util";
import { ERROR_CODES, type ErrorCode } from "@axis/audit";

/**
 * Error summaries (design section 9.2). A summary is built from closed sets only: it never contains text that
 * came from the error, so a message, a `cause`, a stack, a getter result or a `Proxy` trap cannot put a secret
 * into a log line, an audit event or a wire answer.
 */

/** Error class names that may appear in a summary. Anything else is reported as `Error`. */
export const ERROR_NAMES = [
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "EvalError",
  "URIError",
  "AggregateError",
  "AxisError",
  "ZodError",
  "ChallengeError",
  "WorktreeError",
  "GitOpsError",
  "DaemonError",
  "ApprovalError",
  "AbortError",
  "NonError",
] as const;
export type ErrorName = (typeof ERROR_NAMES)[number];

/** Operating system and runtime error codes that may appear as `errno`. */
export const ERRNO_NAMES = [
  "EACCES", "EAGAIN", "EBUSY", "ECONNREFUSED", "ECONNRESET", "EEXIST", "EINVAL", "EIO", "EISDIR", "ELOOP",
  "EMFILE", "ENAMETOOLONG", "ENFILE", "ENOENT", "ENOMEM", "ENOSPC", "ENOTDIR", "ENOTEMPTY", "EPERM", "EPIPE",
  "EROFS", "ETIMEDOUT", "EXDEV",
  "ERR_SQLITE_ERROR", "ERR_INVALID_ARG_TYPE", "ERR_INVALID_ARG_VALUE", "ERR_OUT_OF_RANGE", "ERR_ASSERTION",
  "ERR_IPC_CHANNEL_CLOSED", "ERR_STREAM_DESTROYED", "ABORT_ERR",
] as const;
export type ErrnoName = (typeof ERRNO_NAMES)[number];

export interface ErrorSummary {
  readonly name: ErrorName;
  /** An ADR 0003 code, when the error carries one. */
  readonly code?: ErrorCode;
  /** A system or runtime code such as `ENOENT`, when the error carries one. */
  readonly errno?: ErrnoName;
}

const NAMES: ReadonlySet<string> = new Set(ERROR_NAMES);
const ERRNOS: ReadonlySet<string> = new Set(ERRNO_NAMES);
const CODES: ReadonlySet<string> = new Set(ERROR_CODES);
/** A string longer than this is not looked up at all. Every closed-set member is far shorter. */
const MAX_LOOKUP_CHARS = 64;
const MAX_PROTOTYPE_DEPTH = 8;

/** The value of an own data property, or undefined for a missing property, a getter or a non-string. */
function ownString(obj: object, key: string): string | undefined {
  const d = Object.getOwnPropertyDescriptor(obj, key);
  if (d === undefined || !("value" in d)) return undefined;
  const v: unknown = d.value;
  return typeof v === "string" && v.length <= MAX_LOOKUP_CHARS ? v : undefined;
}

/** Name from the object or its (ordinary) prototype chain; stops at the first closed-set hit. */
function readName(obj: object): ErrorName {
  let cur: object | null = obj;
  for (let depth = 0; cur !== null && depth < MAX_PROTOTYPE_DEPTH; depth++) {
    if (types.isProxy(cur)) return "Error";
    const n = ownString(cur, "name");
    if (n !== undefined && NAMES.has(n)) return n as ErrorName;
    cur = Object.getPrototypeOf(cur) as object | null;
  }
  return "Error";
}

/**
 * `{ name, code?, errno? }` for anything that was thrown. Reads own data properties only, through
 * `Object.getOwnPropertyDescriptor`, so no getter runs, and never touches a `Proxy` (it is reported as a plain
 * `Error`). It does not read `message`, `stack` or `cause`, and a value outside the closed sets is dropped, not
 * truncated. It never throws.
 */
export function summarizeError(error: unknown): ErrorSummary {
  try {
    if ((typeof error !== "object" && typeof error !== "function") || error === null) return Object.freeze({ name: "NonError" });
    if (types.isProxy(error)) return Object.freeze({ name: "Error" });
    const name = readName(error);
    const raw = ownString(error, "code");
    if (raw !== undefined && CODES.has(raw)) return Object.freeze({ name, code: raw as ErrorCode });
    if (raw !== undefined && ERRNOS.has(raw)) return Object.freeze({ name, errno: raw as ErrnoName });
    return Object.freeze({ name });
  } catch {
    return Object.freeze({ name: "Error" });
  }
}
