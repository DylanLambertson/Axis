// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { createHash } from "node:crypto";
import { AxisError } from "./errors.js";
import type { JsonValue } from "./canonical.js";

/** Kinds that appear in `[REDACTED:<kind>]` placeholders. */
export type RedactionKind =
  | "private-key"
  | "url-credentials"
  | "authorization"
  | "cookie"
  | "api-key-header"
  | "env-secret"
  | "jwt"
  | "anthropic-api-key"
  | "openai-api-key"
  | "google-api-key"
  | "aws-access-key"
  | "github-token"
  | "registered-secret"
  | "encoded-secret"
  | "sensitive-field";

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const LONE_SURROGATES = new RegExp(LONE_SURROGATE.source, "g");

/** True if `s` has no lone surrogates (the ES2024 `isWellFormed`, which the ES2023 lib target lacks). */
export const isWellFormedString = (s: string): boolean => !LONE_SURROGATE.test(s);

/** Replace lone surrogates with U+FFFD (the ES2024 `toWellFormed`). */
export const wellFormed = (s: string): string => s.replace(LONE_SURROGATES, "\ufffd");

export const placeholder = (kind: RedactionKind): string => `[REDACTED:${kind}]`;

/** Registered secrets shorter than this would shred ordinary text, so they are refused. */
export const MIN_REGISTERED_SECRET_LENGTH = 8;

/**
 * Every string is cut to this many characters before any rule runs, so the
 * cost of `redactString` is bounded whatever a repository, a CLI or a model
 * puts in it. The cut is recorded: `[TRUNCATED:<original length>]`.
 */
export const MAX_STRING_CHARS = 16_384;
const MAX_KEY_CHARS = 256;
/** Keys kept per object; the rest are counted in a `[truncated]` marker. */
const MAX_KEYS_PER_OBJECT = 1024;
/** Values visited and characters kept per `redactValue` call. */
const MAX_NODES = 10_000;
const MAX_TOTAL_CHARS = 1_048_576;
const MAX_VALUE_DEPTH = 32;
/** Base64-looking runs between these lengths are decoded and re-scanned. */
const ENCODED_RUN_MIN = 16;
const ENCODED_RUN_MAX = 4096;
const MAX_BINARY_HASH_BYTES = 16 * 1024 * 1024;

export interface RedactionRule {
  readonly kind: RedactionKind;
  /** Pure and linear in the input length. */
  readonly apply: (input: string) => string;
}

const regexRule = (
  kind: RedactionKind,
  regex: RegExp,
  replace: (match: string, ...groups: string[]) => string,
): RedactionRule => ({ kind, apply: (s) => s.replace(regex, replace as (substring: string, ...args: unknown[]) => string) });

/** Delimiters that end a URL-ish token: whitespace, quotes and angle brackets (by char code, for speed). */
function isUrlDelim(c: number): boolean {
  return (
    c <= 32 || c === 34 || c === 39 || c === 60 || c === 62 || c === 0xa0 || c === 0x2028 || c === 0x2029 ||
    c === 0xfeff || (c >= 0x2000 && c <= 0x200a)
  );
}
function isSchemeChar(c: number): boolean {
  return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 43 || c === 46 || c === 45;
}
const isAsciiLetter = (c: number): boolean => (c >= 97 && c <= 122) || (c >= 65 && c <= 90);

/**
 * Credentials in URL userinfo. Linear scanner (a regex for this had
 * quadratic backtracking): for each `://`, take the token up to the next
 * delimiter (at most 512 characters) and look for its last `@`. Redacted:
 * `user:pass@` and `:pass@` (the password may contain `/`), and token-only
 * `TOKEN@` of 16 or more characters. A token with no `@` is skipped as a
 * whole, which is what keeps the scan linear.
 */
function redactUrlCredentials(input: string): string {
  let out = "";
  let copied = 0;
  let from = 0;
  for (;;) {
    const p = input.indexOf("://", from);
    if (p < 0) break;
    from = p + 3;
    // scheme: [a-z][a-z0-9+.-]{0,31} directly before, not preceded by another scheme char
    let s = p;
    while (s > 0 && p - s < 33 && isSchemeChar(input.charCodeAt(s - 1))) s--;
    if (p - s < 1 || p - s > 32 || !isAsciiLetter(input.charCodeAt(s))) continue;
    if (s > 0 && isSchemeChar(input.charCodeAt(s - 1))) continue;
    const start = p + 3;
    let end = start;
    const cap = Math.min(input.length, start + 512);
    while (end < cap && !isUrlDelim(input.charCodeAt(end))) end++;
    let at = end - 1;
    while (at >= start && input.charCodeAt(at) !== 64) at--;
    if (at < start) {
      from = Math.max(from, end);
      continue;
    }
    const userinfo = input.slice(start, at);
    const colon = userinfo.indexOf(":");
    const user = colon < 0 ? userinfo : userinfo.slice(0, colon);
    const pass = colon < 0 ? "" : userinfo.slice(colon + 1);
    const bad = (x: string, chars: RegExp) => chars.test(x);
    const ok =
      colon >= 0
        ? !bad(user, /[/?#]/) && !bad(pass, /[?#]/) && pass.length > 0
        : userinfo.length >= 16 && !bad(userinfo, /[/?#]/);
    if (!ok) {
      from = Math.max(from, end);
      continue;
    }
    out += input.slice(copied, start) + placeholder("url-credentials");
    copied = at;
    from = at + 1;
  }
  return copied === 0 ? input : out + input.slice(copied);
}

/**
 * Pattern rules, applied in order: container shapes (key blocks, URLs,
 * headers, environment assignments) before bare token shapes, so the larger
 * span wins. Every replacement is a fixed placeholder, so redaction is
 * deterministic and idempotent. The timing test runs every rule on adversarial
 * 1 MiB inputs.
 */
export const REDACTION_RULES: readonly RedactionRule[] = [
  regexRule(
    "private-key",
    // Complete block, or one truncated before its END line (log cut-off).
    /-----BEGIN (?:[A-Z0-9]+ ){0,4}PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ ){0,4}PRIVATE KEY(?: BLOCK)?-----|$)/g,
    () => placeholder("private-key"),
  ),
  { kind: "url-credentials", apply: redactUrlCredentials },
  regexRule(
    "authorization",
    /(\b(?:proxy-)?authorization\\?["']?\s*[:=]\s*\\?["']?)(?:(?:bearer|basic|token|digest)\s+)?[^\s,;"'\\]+/gi,
    (_m, prefix = "") => `${prefix}${placeholder("authorization")}`,
  ),
  regexRule(
    "cookie",
    /(\b(?:set-)?cookie\\?["']?\s*[:=]\s*\\?["']?)[^\r\n"'\\]+/gi,
    (_m, prefix = "") => `${prefix}${placeholder("cookie")}`,
  ),
  regexRule(
    "api-key-header",
    /(\b(?:x-api-key|x-auth-token|api-key)\\?["']?\s*[:=]\s*\\?["']?)[^\s,;"'\\]+/gi,
    (_m, prefix = "") => `${prefix}${placeholder("api-key-header")}`,
  ),
  regexRule(
    "authorization",
    /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g,
    () => `Bearer ${placeholder("authorization")}`,
  ),
  regexRule("authorization", /\bBasic\s+[A-Za-z0-9+/]{16,}={0,2}/g, () => `Basic ${placeholder("authorization")}`),
  regexRule(
    "env-secret",
    // NAME=value, NAME: value and JSON-text "name": "value", where NAME mentions a secret-ish word
    // (AWS_SECRET_ACCESS_KEY=..., DB_PWD=..., password: ..., client_secret: ..., "secret_key": "...").
    /(\b[A-Za-z0-9_]{0,64}(?:secret|token|password|passwd|pwd|apikey|api_key|access_key|private_key|credential)[A-Za-z0-9_]{0,64}\\?["']?\s*[:=]\s*)(?:\\?"[^"\r\n]*"|\\?'[^'\r\n]*'|[^\s"',;}\\]+)/gi,
    (_m, prefix = "") => `${prefix}${placeholder("env-secret")}`,
  ),
  regexRule("jwt", /\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, () => placeholder("jwt")),
  regexRule("anthropic-api-key", /\bsk-ant-[A-Za-z0-9_-]{16,}/g, () => placeholder("anthropic-api-key")),
  regexRule(
    "openai-api-key",
    /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g,
    () => placeholder("openai-api-key"),
  ),
  regexRule("google-api-key", /\bAIza[0-9A-Za-z_-]{35}\b/g, () => placeholder("google-api-key")),
  regexRule("aws-access-key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, () => placeholder("aws-access-key")),
  regexRule(
    "github-token",
    /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g,
    () => placeholder("github-token"),
  ),
];

/** Keys (normalised: lower case, no `-`/`_`/space) whose values are always redacted. */
const SENSITIVE_KEY_EXACT = new Set([
  "authorization",
  "proxyauthorization",
  "cookie",
  "setcookie",
  "credential",
  "credentials",
  "bearer",
  "auth",
  "pwd",
  "signature",
]);
const SENSITIVE_KEY_SUFFIXES = [
  "password",
  "passwd",
  "passphrase",
  "secret",
  "token",
  "apikey",
  "privatekey",
  "accesskey",
  "secretkey",
  "sessionid",
  "pwd",
];

function isSensitiveKey(key: string): boolean {
  const normalised = key.toLowerCase().replace(/[-_\s]/g, "");
  return SENSITIVE_KEY_EXACT.has(normalised) || SENSITIVE_KEY_SUFFIXES.some((s) => normalised.endsWith(s));
}

/** A length plus SHA-256 for `content`-sensitivity fields (ADR 0003 D5): the text itself is never logged. */
export function summarizeContent(text: string): { readonly length: number; readonly sha256: string } {
  return { length: text.length, sha256: createHash("sha256").update(text).digest("hex") };
}

function summarizeBinary(view: ArrayBufferView | ArrayBuffer): JsonValue {
  const bytes =
    view instanceof ArrayBuffer
      ? new Uint8Array(view)
      : new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  return {
    "[binary]": {
      length: bytes.byteLength,
      sha256: bytes.byteLength <= MAX_BINARY_HASH_BYTES ? createHash("sha256").update(bytes).digest("hex") : null,
    },
  };
}

/** Cut `s` to `max` characters, dropping a partial token at the cut (it could be a secret prefix). */
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  let cut = s.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  cut = cut.replace(/[A-Za-z0-9_+/=.-]+$/, "");
  return `${cut}[TRUNCATED:${s.length}]`;
}

function base64Variants(raw: Buffer): string[] {
  const std = raw.toString("base64");
  const url = raw.toString("base64url");
  return [std, std.replace(/=+$/, ""), url, url.replace(/=+$/, "")];
}

/**
 * Deterministic redaction of strings and structured payloads. One instance per
 * process holds the explicitly registered secret values (for example the
 * connection vault's API keys); the pattern rules are fixed.
 */
export class Redactor {
  #literals: string[] = [];

  /**
   * Register an exact secret value. Its raw, NFC/NFD, URL-encoded (either
   * case), base64 and base64url (padded or not), hex and JSON-escaped forms
   * are all redacted from then on. Secrets shorter than
   * `MIN_REGISTERED_SECRET_LENGTH` are refused: rely on key-based redaction
   * for short values such as PINs.
   */
  registerSecret(value: string): void {
    if (typeof value !== "string" || value.length < MIN_REGISTERED_SECRET_LENGTH) {
      throw new AxisError(
        "E_INVALID_ARGUMENT",
        `A registered secret must be a string of at least ${MIN_REGISTERED_SECRET_LENGTH} characters`,
      );
    }
    const variants = new Set<string>();
    for (const form of new Set([value, value.normalize("NFC"), value.normalize("NFD")])) {
      const buf = Buffer.from(form, "utf8");
      const enc = encodeURIComponent(form);
      for (const v of [
        form,
        JSON.stringify(form).slice(1, -1),
        enc,
        enc.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()),
        buf.toString("hex"),
        buf.toString("hex").toUpperCase(),
        ...base64Variants(buf),
      ]) {
        if (v.length >= MIN_REGISTERED_SECRET_LENGTH) variants.add(v);
      }
    }
    const next = new Set([...this.#literals, ...variants]);
    // Longest first so a secret that contains another is replaced whole.
    this.#literals = [...next].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
  }

  /** The rules and registered literals, on a string already made well-formed and bounded. */
  #scan(input: string): string {
    let out = input;
    for (const literal of this.#literals) {
      if (out.includes(literal)) out = out.split(literal).join(placeholder("registered-secret"));
    }
    for (const rule of REDACTION_RULES) out = rule.apply(out);
    return out;
  }

  redactString(input: string): string {
    const bounded = truncate(wellFormed(input), MAX_STRING_CHARS);
    let out = this.#scan(bounded);
    // Encoded secrets: decode base64-looking runs and re-scan them. A run can start anywhere inside an
    // encoded value (a path segment or a prefix such as `x_` shifts it), so decode at all four offsets.
    out = out.replace(/[A-Za-z0-9+/_-]{16,4096}={0,2}/g, (run) => {
      if (run.length < ENCODED_RUN_MIN || run.length > ENCODED_RUN_MAX) return run;
      for (let shift = 0; shift < 4; shift++) {
        const decoded = Buffer.from(run.slice(shift), "base64").toString("utf8");
        if (this.#scan(decoded) !== decoded) return placeholder("encoded-secret");
      }
      return run;
    });
    return out;
  }

  /**
   * Deep-redact any value into plain JSON. Bounded: at most 10,000 values (values
   * under sensitive keys count too), 1,024 keys per object and 1 MiB of text per call, each object visited once (shared and circular
   * references become markers), unreadable properties become a fixed
   * placeholder. Binary data is never copied or decoded: only its length and
   * SHA-256 are kept. Values under sensitive keys are replaced wholesale and
   * Errors keep only name and message.
   */
  redactValue(value: unknown): JsonValue {
    const budget = { nodes: 0, chars: 0 };
    return this.#walk(value, 0, new Set<object>(), new Set<object>(), budget) ?? null;
  }

  #walk(
    value: unknown,
    depth: number,
    path: Set<object>,
    seen: Set<object>,
    budget: { nodes: number; chars: number },
  ): JsonValue | undefined {
    if (++budget.nodes > MAX_NODES) return "[TRUNCATED:size]";
    switch (typeof value) {
      case "string": {
        if (budget.chars > MAX_TOTAL_CHARS) return "[TRUNCATED:size]";
        const out = this.redactString(value);
        budget.chars += out.length;
        return out;
      }
      case "number":
        return Number.isFinite(value) ? value : null;
      case "boolean":
        return value;
      case "bigint":
        return value.toString();
      case "undefined":
      case "function":
      case "symbol":
        return undefined;
      default:
        break;
    }
    if (value === null) return null;
    const obj = value as object;
    if (depth >= MAX_VALUE_DEPTH) return "[TRUNCATED:depth]";
    if (path.has(obj)) return "[CIRCULAR]";
    if (seen.has(obj)) return "[SHARED]";
    seen.add(obj);
    path.add(obj);
    try {
      if (ArrayBuffer.isView(obj) || obj instanceof ArrayBuffer) return summarizeBinary(obj);
      if (obj instanceof Date) return Number.isNaN(obj.getTime()) ? null : obj.toISOString();
      if (obj instanceof Map) return `[Map:${obj.size}]`;
      if (obj instanceof Set) return `[Set:${obj.size}]`;
      if (Array.isArray(obj)) {
        const out: JsonValue[] = [];
        for (let i = 0; i < obj.length; i++) {
          if (budget.nodes > MAX_NODES) {
            out.push("[TRUNCATED:size]");
            break;
          }
          out.push(this.#walk(this.#read(obj, i), depth + 1, path, seen, budget) ?? null);
        }
        return out;
      }
      if (obj instanceof Error) {
        return {
          name: this.redactString(String(this.#read(obj, "name") ?? "Error")),
          message: this.redactString(String(this.#read(obj, "message") ?? "")),
        };
      }
      const out: Record<string, JsonValue> = {};
      const keys = Object.keys(obj);
      for (let k = 0; k < keys.length; k++) {
        const key = keys[k] as string;
        if (budget.nodes > MAX_NODES || budget.chars > MAX_TOTAL_CHARS || k >= MAX_KEYS_PER_OBJECT) {
          out["[truncated]"] = `[TRUNCATED:size:${keys.length - k} keys]`;
          break;
        }
        const raw = this.#read(obj, key);
        // Cut the key before the rules run, so a huge key costs a bounded amount.
        const safeKey = truncate(this.redactString(truncate(key, MAX_KEY_CHARS)), MAX_KEY_CHARS);
        budget.chars += safeKey.length;
        let slot = safeKey;
        for (let n = 2; Object.hasOwn(out, slot); n++) slot = `${safeKey}#${n}`;
        let walked: JsonValue | undefined;
        if (isSensitiveKey(key) && raw !== null && raw !== undefined && raw !== "") {
          // The value is replaced, but it still costs one node, so sensitive keys cannot be used to flood the walk.
          budget.nodes++;
          walked = placeholder("sensitive-field");
        } else {
          walked = this.#walk(raw, depth + 1, path, seen, budget);
        }
        if (walked === undefined) continue;
        // defineProperty so a key named "__proto__" is data, never a prototype write.
        Object.defineProperty(out, slot, { value: walked, enumerable: true, writable: true, configurable: true });
      }
      return out;
    } catch {
      return "[UNREADABLE]";
    } finally {
      path.delete(obj);
    }
  }

  /** Property read that cannot throw (getters, proxies): a failure is a fixed marker. */
  #read(obj: object, key: PropertyKey): unknown {
    try {
      return (obj as Record<PropertyKey, unknown>)[key];
    } catch {
      return "[UNREADABLE]";
    }
  }
}
