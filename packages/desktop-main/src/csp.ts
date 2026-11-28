// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

/**
 * The Content Security Policy of every app-scheme response (ADR 0011 Decision 2 and Decision 5; threat model EL-1, EL-3). Sent as a
 * response header by the scheme handler, so it also covers workers, whose policy comes from their own response.
 *
 * - Nothing loads from anywhere but the app origin (`'self'`), and there is no `data:`, `blob:` or inline script. `connect-src` is
 *   `'none'` as ADR 0011 fixes it: `import()` is governed by `script-src` and workers by `worker-src` (measured on Electron
 *   45.3.2); the renderer reaches the daemon only through the brokered port. `img-src` is `'self'`, without the ADR's `data:`.
 * - Trusted Types are required for every script sink. The policy names are listed exactly: no `*`, no `'allow-duplicates'`.
 *   With no names, `trusted-types 'none'` lets no policy be created. The name `default` is refused: a default policy is called
 *   implicitly for every string that reaches a sink, so a pass-through one would disable the protection everywhere. The editor kit (OS-18) adds Monaco's names at its pinned
 *   version, with a test that fails when an upgrade adds or renames one.
 * - `style-src` keeps `'unsafe-inline'`: Monaco and xterm.js insert `<style>` elements at run time. A style cannot run script.
 * - No frames of any kind, no plugins, no forms, no `<base>`, and the window cannot be framed.
 */

/** A Trusted Types policy name: the characters the CSP grammar allows, bounded. */
const POLICY_NAME = /^[A-Za-z0-9#=_/@.%-]{1,64}$/;
const MAX_POLICIES = 16;

export class CspError extends Error {}

export interface CspOptions {
  /** The exact Trusted Types policy names the renderer creates. Empty: no policy may be created. */
  readonly trustedTypesPolicies: readonly string[];
}

/** The directives, in order. `trusted-types` is appended by `buildCsp`. */
export const CSP_DIRECTIVES: ReadonlyArray<readonly [string, string]> = Object.freeze([
  ["default-src", "'none'"],
  ["script-src", "'self'"],
  ["style-src", "'self' 'unsafe-inline'"],
  ["img-src", "'self'"],
  ["font-src", "'self'"],
  ["connect-src", "'none'"],
  ["worker-src", "'self'"],
  ["child-src", "'none'"],
  ["frame-src", "'none'"],
  ["object-src", "'none'"],
  ["media-src", "'none'"],
  ["manifest-src", "'none'"],
  ["base-uri", "'none'"],
  ["form-action", "'none'"],
  ["frame-ancestors", "'none'"],
  ["require-trusted-types-for", "'script'"],
] as const);

/** The policy header value. Throws `CspError` on a bad, duplicate or wildcard policy name. */
export function buildCsp(options: CspOptions): string {
  const names = options.trustedTypesPolicies;
  if (!Array.isArray(names) || names.length > MAX_POLICIES) throw new CspError("csp: trustedTypesPolicies must be an array of at most 16 names");
  const seen = new Set<string>();
  for (const n of names) {
    if (typeof n !== "string" || !POLICY_NAME.test(n)) throw new CspError("csp: a Trusted Types policy name is not allowed");
    if (n === "default") throw new CspError("csp: the default Trusted Types policy is refused");
    if (seen.has(n)) throw new CspError("csp: a Trusted Types policy name is listed twice");
    seen.add(n);
  }
  const tt = names.length === 0 ? "'none'" : names.join(" ");
  return [...CSP_DIRECTIVES.map(([d, v]) => `${d} ${v}`), `trusted-types ${tt}`].join("; ");
}

/** The headers every app-scheme response carries, success or error. */
export function securityHeaders(csp: string): Readonly<Record<string, string>> {
  return Object.freeze({
    "Content-Security-Policy": csp,
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-cache",
  });
}
