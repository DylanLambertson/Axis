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
  /**
   * A redactor fixed to the current secret set, for scanning many strings of
   * one request without asking the vault for each (N3). Optional for custom
   * implementations; the guard falls back to the redactor itself.
   */
  snapshot?(): Redactor;
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

export interface SecretRedactor extends Redactor {
  /**
   * How many of the current secrets are shorter than `minSecretLength` and so
   * neither redacted nor scanned for (N4). The vault warns when this is not 0.
   */
  skippedSecrets(): number;
}

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
export function createSecretRedactor(options: SecretRedactorOptions): SecretRedactor {
  const min = options.minSecretLength ?? DEFAULT_MIN_SECRET_LENGTH;
  // Global, never sticky: a sticky pattern only matches at consecutive positions (N4).
  const patterns = (options.patterns ?? []).map((p) => new RegExp(p.source, `${p.flags.replace(/[gy]/g, "")}g`));

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

  const over = (get: () => readonly string[]): Redactor => ({
    redact(text: string): string {
      let out = text;
      for (const n of get()) out = out.split(n).join(REDACTED);
      for (const p of patterns) out = out.replace(p, REDACTED);
      return out;
    },
    containsSecret(text: string): boolean {
      for (const n of get()) if (text.includes(n)) return true;
      for (const p of patterns) {
        p.lastIndex = 0;
        if (p.test(text)) return true;
      }
      return false;
    },
  });

  const live = over(needles);
  return {
    ...live,
    skippedSecrets() {
      let n = 0;
      for (const s of options.secrets()) if (typeof s === "string" && s.length > 0 && s.length < min) n += 1;
      return n;
    },
    snapshot() {
      const fixed = needles();
      return over(() => fixed);
    },
  };
}

/**
 * True when any string in `value` (keys included) holds a secret. Walks the
 * raw, unvalidated value without invoking getters, so it can run before the
 * schema (S1). Returns `"unwalkable"` for anything that is not plain data
 * (accessors, class instances, more than `maxNodes` values); callers refuse
 * those.
 */
export function scanForSecret(value: unknown, redactor: Redactor, maxNodes = 200_000): "secret" | "clean" | "unwalkable" {
  const seen = new WeakSet<object>();
  const stack: unknown[] = [value];
  let nodes = 0;
  while (stack.length > 0) {
    if (++nodes > maxNodes) return "unwalkable";
    const v = stack.pop();
    if (typeof v === "string") {
      if (redactor.containsSecret(v)) return "secret";
      continue;
    }
    if (typeof v !== "object" || v === null) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    const proto = Object.getPrototypeOf(v) as unknown;
    if (!Array.isArray(v) && proto !== Object.prototype && proto !== null) return "unwalkable";
    for (const key of Object.getOwnPropertyNames(v)) {
      if (Array.isArray(v) && key === "length") continue;
      if (redactor.containsSecret(key)) return "secret";
      const d = Object.getOwnPropertyDescriptor(v, key);
      if (d === undefined || d.get !== undefined || d.set !== undefined) return "unwalkable";
      stack.push(d.value);
    }
  }
  return "clean";
}

/**
 * A redactor that knows no secrets. The guard requires a redactor (S10); this
 * exists for tests and for connections that hold no credential (the mock),
 * and must be passed explicitly.
 */
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
