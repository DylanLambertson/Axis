// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

/** What replaces a redacted value. */
export const REDACTED = "[REDACTED]";

/**
 * Redaction hook (PRV-2, DMN-6). The guard calls it on every string that
 * leaves the provider layer for a log, an error or the UI, and asks it whether
 * an outgoing request carries a credential.
 */
export interface Redactor {
  /** Replace every known secret and secret-shaped substring. */
  redact(text: string): string;
  /** True when `text` contains a known secret or matches a secret pattern. */
  containsSecret(text: string): boolean;
}

export interface SecretRedactorOptions {
  /**
   * Current secret values. A function so the vault (ticket 9) can supply the
   * live set after rotation without rebuilding the redactor. Values shorter
   * than `minSecretLength` are ignored: redacting a three-letter string would
   * mangle ordinary text and gives no protection.
   */
  readonly secrets: () => Iterable<string>;
  /** Secret-shaped patterns, for example a provider's key prefix. */
  readonly patterns?: readonly RegExp[];
  readonly minSecretLength?: number;
}

export const DEFAULT_MIN_SECRET_LENGTH = 8;

/**
 * Exact-match plus pattern redactor. Exact matches cover the value itself and
 * its URL-encoded and JSON-escaped forms; longer secrets are replaced first
 * so one that contains another is fully removed.
 *
 * Limits: it does not find a secret split across separately redacted strings
 * (for example two stream deltas) or transformed in other ways (base64,
 * reversed). The guard therefore refuses requests that contain a secret
 * rather than relying on redaction downstream.
 */
export function createSecretRedactor(options: SecretRedactorOptions): Redactor {
  const min = options.minSecretLength ?? DEFAULT_MIN_SECRET_LENGTH;
  const patterns = (options.patterns ?? []).map(
    (p) => new RegExp(p.source, p.flags.includes("g") ? p.flags : `${p.flags}g`),
  );

  const needles = (): string[] => {
    const out = new Set<string>();
    for (const s of options.secrets()) {
      if (typeof s !== "string" || s.length < min) continue;
      out.add(s);
      out.add(encodeURIComponent(s));
      out.add(JSON.stringify(s).slice(1, -1));
    }
    return [...out].filter((s) => s.length >= min).sort((a, b) => b.length - a.length);
  };

  return {
    redact(text: string): string {
      let out = text;
      for (const n of needles()) out = out.split(n).join(REDACTED);
      for (const p of patterns) out = out.replace(p, REDACTED);
      return out;
    },
    containsSecret(text: string): boolean {
      for (const n of needles()) if (text.includes(n)) return true;
      for (const p of patterns) {
        p.lastIndex = 0;
        if (p.test(text)) return true;
      }
      return false;
    },
  };
}

/** A redactor that knows no secrets. Used when the caller passes none. */
export const NO_SECRETS: Redactor = { redact: (t) => t, containsSecret: () => false };

/** Every string in a JSON-like value, keys included, without recursion. */
export function* stringsIn(value: unknown): Generator<string> {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const v = stack.pop();
    if (typeof v === "string") yield v;
    else if (Array.isArray(v)) for (const x of v) stack.push(x);
    else if (typeof v === "object" && v !== null) {
      for (const [k, x] of Object.entries(v)) {
        yield k;
        stack.push(x);
      }
    }
  }
}
