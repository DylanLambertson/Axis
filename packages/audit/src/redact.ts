// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { createHash } from "node:crypto";
import { AxisError } from "./errors.js";
import type { JsonValue } from "./canonical.js";

/** Kinds that appear in `[REDACTED:<kind>]` placeholders. */
export type RedactionKind =
  | "private-key"
  | "url-credentials"
  | "authorization"
  | "jwt"
  | "anthropic-api-key"
  | "openai-api-key"
  | "google-api-key"
  | "aws-access-key"
  | "github-token"
  | "registered-secret"
  | "sensitive-field";

export const placeholder = (kind: RedactionKind): string => `[REDACTED:${kind}]`;

/** Registered secrets shorter than this would shred ordinary text, so they are refused. */
export const MIN_REGISTERED_SECRET_LENGTH = 8;

const MAX_VALUE_DEPTH = 32;

interface PatternRule {
  readonly kind: RedactionKind;
  readonly regex: RegExp;
  readonly replace: (match: string, ...groups: string[]) => string;
}

/**
 * Pattern rules, applied in order. Order matters: container shapes (key
 * blocks, URLs, headers) run before bare token shapes so the larger span wins.
 * Every replacement is a fixed placeholder, so redaction is deterministic and
 * idempotent (placeholders never match a rule).
 */
const RULES: readonly PatternRule[] = [
  {
    kind: "private-key",
    // Complete block, or a block truncated before its END line (log cut-off).
    regex:
      /-----BEGIN ((?:[A-Z0-9]+ )*)PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----|$)/g,
    replace: () => placeholder("private-key"),
  },
  {
    kind: "url-credentials",
    regex: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@:"'<>]+:[^\s/?#@"'<>]+@/gi,
    replace: (_m, scheme = "") => `${scheme}${placeholder("url-credentials")}@`,
  },
  {
    kind: "authorization",
    regex: /(\b(?:proxy-)?authorization["']?\s*[:=]\s*["']?)(?:(?:bearer|basic|token|digest)\s+)?[^\s,;"']+/gi,
    replace: (_m, prefix = "") => `${prefix}${placeholder("authorization")}`,
  },
  {
    kind: "authorization",
    regex: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g,
    replace: () => `Bearer ${placeholder("authorization")}`,
  },
  {
    kind: "jwt",
    regex: /\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g,
    replace: () => placeholder("jwt"),
  },
  {
    kind: "anthropic-api-key",
    regex: /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
    replace: () => placeholder("anthropic-api-key"),
  },
  {
    kind: "openai-api-key",
    regex: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g,
    replace: () => placeholder("openai-api-key"),
  },
  {
    kind: "google-api-key",
    regex: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    replace: () => placeholder("google-api-key"),
  },
  {
    kind: "aws-access-key",
    regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    replace: () => placeholder("aws-access-key"),
  },
  {
    kind: "github-token",
    regex: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g,
    replace: () => placeholder("github-token"),
  },
];

/** Keys (normalised: lower case, no `-`/`_`) whose values are always redacted. */
const SENSITIVE_KEY_EXACT = new Set([
  "authorization",
  "proxyauthorization",
  "cookie",
  "setcookie",
  "credential",
  "credentials",
  "bearer",
  "auth",
]);
const SENSITIVE_KEY_SUFFIXES = ["password", "passwd", "passphrase", "secret", "token", "apikey", "privatekey"];

function isSensitiveKey(key: string): boolean {
  const normalised = key.toLowerCase().replace(/[-_\s]/g, "");
  return SENSITIVE_KEY_EXACT.has(normalised) || SENSITIVE_KEY_SUFFIXES.some((s) => normalised.endsWith(s));
}

/** A length plus SHA-256 for `content`-sensitivity fields (ADR 0003 D5): the text itself is never logged. */
export function summarizeContent(text: string): { readonly length: number; readonly sha256: string } {
  return { length: text.length, sha256: createHash("sha256").update(text).digest("hex") };
}

/**
 * Deterministic redaction of strings and structured payloads. One instance per
 * process holds the explicitly registered secret values (for example the
 * connection vault's API keys); the pattern rules are fixed.
 */
export class Redactor {
  #literals: string[] = [];

  /**
   * Register an exact secret value. Its raw, URL-encoded, base64 and
   * JSON-escaped forms are all redacted from then on.
   */
  registerSecret(value: string): void {
    if (typeof value !== "string" || value.length < MIN_REGISTERED_SECRET_LENGTH) {
      throw new AxisError(
        "E_INVALID_ARGUMENT",
        `A registered secret must be a string of at least ${MIN_REGISTERED_SECRET_LENGTH} characters`,
      );
    }
    const variants = new Set<string>([
      value,
      encodeURIComponent(value),
      Buffer.from(value, "utf8").toString("base64"),
      JSON.stringify(value).slice(1, -1),
    ]);
    const next = new Set([...this.#literals, ...variants]);
    // Longest first so a secret that contains another is replaced whole.
    this.#literals = [...next].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
  }

  redactString(input: string): string {
    let out = input;
    for (const literal of this.#literals) {
      if (out.includes(literal)) out = out.split(literal).join(placeholder("registered-secret"));
    }
    for (const rule of RULES) {
      out = out.replace(rule.regex, rule.replace);
    }
    return out;
  }

  /**
   * Deep-redact any value into plain JSON. Strings and object keys are
   * scanned; values under sensitive keys are replaced wholesale; Errors keep
   * only name and message; cycles and over-deep structures are cut off.
   */
  redactValue(value: unknown): JsonValue {
    return this.#walk(value, 0, new Set<object>()) ?? null;
  }

  #walk(value: unknown, depth: number, seen: Set<object>): JsonValue | undefined {
    switch (typeof value) {
      case "string":
        return this.redactString(value);
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
    if (seen.has(obj)) return "[CIRCULAR]";
    if (obj instanceof Date) return Number.isNaN(obj.getTime()) ? null : obj.toISOString();
    seen.add(obj);
    try {
      if (Array.isArray(obj)) {
        return obj.map((item) => this.#walk(item, depth + 1, seen) ?? null);
      }
      if (obj instanceof Error) {
        return { name: this.redactString(obj.name), message: this.redactString(obj.message) };
      }
      const out: Record<string, JsonValue> = {};
      for (const key of Object.keys(obj)) {
        const raw = (obj as Record<string, unknown>)[key];
        const safeKey = this.redactString(key);
        let slot = safeKey;
        for (let n = 2; Object.hasOwn(out, slot); n++) slot = `${safeKey}#${n}`;
        const walked =
          isSensitiveKey(key) && raw !== null && raw !== undefined && raw !== ""
            ? placeholder("sensitive-field")
            : this.#walk(raw, depth + 1, seen);
        if (walked === undefined) continue;
        // defineProperty so a key named "__proto__" is data, never a prototype write.
        Object.defineProperty(out, slot, { value: walked, enumerable: true, writable: true, configurable: true });
      }
      return out;
    } finally {
      seen.delete(obj);
    }
  }
}
