// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

import type { ComposedRequest, Method } from "./compose-request.js";
import { originSchema } from "@axis/protocol";
import { copyBytes, isBytes } from "./bytes.js";
import type { EgressTarget } from "./host.js";

/*
 * The final URL check before the credential (ticket PV-N1e; ADR 0009 decision 3, INT-6). `matchTarget` reads ONLY the
 * PARSED `target.url` that `egressTarget` (host.ts) returned for the composed URL, never the raw string, and compares
 * ENCODED forms exactly: the origin; no userinfo, no fragment, not even an empty `#`; every path segment, literal or
 * placeholder, equal to the composed one and in the one encoded spelling (upper-case hex); the query keys exactly the
 * composed ones, in the composed order, each once, each with its composed value; and finally the whole `href` equal to the
 * composed URL (compose -> parse is the identity, or the request is refused).
 *
 * A match SNAPSHOTS what will be sent (review 1 SF1): the integration, the origin, the href, the method and a copy of the
 * body, as frozen values in a module-private record. Nothing later reads the caller's target or composed objects again, so
 * changing them after the match changes nothing. The MatchedTarget returned is a brand for that record (type level and run
 * time), SINGLE-USE, and a composed request can be matched once (review 1 nit a).
 *
 * `authorize` is the only way to attach a `Credential`, and it refuses anything that is not an unspent MatchedTarget, and a
 * credential bound to another integration or origin (review 1 SF2, `credential_mismatch`). The AuthorizedRequest carries
 * the snapshot only; its header value is not a property at all (review 1 nit c): the egress client reads it through
 * `authorizationOf`, the one reader. LIMIT, stated plainly: the value is in process memory, so a debugger or a heap dump of
 * the daemon sees it; nothing here defends against code running in the daemon itself.
 */

export type MatchRefusal = "target" | "already_matched" | "origin" | "userinfo" | "fragment" | "path" | "query" | "identity";

declare const MATCHED: unique symbol;
export interface MatchedTarget {
  readonly [MATCHED]: true;
  /** The matched origin and URL, frozen copies taken at match time. */
  readonly origin: string;
  readonly href: string;
}

interface Snapshot {
  readonly integration: string;
  readonly origin: string;
  readonly href: string;
  readonly method: Method;
  readonly body: Uint8Array | undefined;
}

/**
 * The built-in URL getters, applied to the target's URL: a subclass may override `origin` or `href` to lie, but these read
 * the parsed record itself (review 2 SF2). Throws for a Proxy or any non-URL, which the caller makes a `target` refusal.
 */
const URL_FIELDS = ["href", "origin", "protocol", "username", "password", "pathname", "search", "hash"] as const;
const URL_GET = Object.fromEntries(URL_FIELDS.map((f) => [f, Object.getOwnPropertyDescriptor(URL.prototype, f)?.get as (this: URL) => string])) as Record<(typeof URL_FIELDS)[number], (this: URL) => string>;
function urlFields(u: URL): Record<(typeof URL_FIELDS)[number], string> {
  return Object.fromEntries(URL_FIELDS.map((f) => [f, Reflect.apply(URL_GET[f], u, []) as string])) as Record<(typeof URL_FIELDS)[number], string>;
}

const records = new WeakMap<object, Snapshot>();
const matchedComposed = new WeakSet<object>();
const SEGMENT = /^(?:[A-Za-z0-9\-._~]|%[0-9A-F]{2})+$/;

/** The match of the parsed target against the composed request: a MatchedTarget, or why it does not match. */
export function matchTarget(composed: ComposedRequest, target: EgressTarget): MatchedTarget | MatchRefusal {
  if (typeof composed !== "object" || composed === null || typeof target !== "object" || target === null) return "target";
  const u: unknown = target.url;
  if (!(u instanceof URL) || typeof target.origin !== "string") return "target";
  if (matchedComposed.has(composed)) return "already_matched";
  // Every field read once: a getter cannot show one value to a check and another to the snapshot.
  const { kind, integration, method, origin, url, segments, query, body } = composed;
  if (typeof integration !== "string" || typeof url !== "string" || !Array.isArray(segments) || !Array.isArray(query) || (body !== undefined && !isBytes(body))) return "target";
  let f: Record<(typeof URL_FIELDS)[number], string>;
  try {
    f = urlFields(u);
  } catch {
    return "target";
  }
  const { href, origin: uOrigin, protocol, pathname, search, hash } = f;
  // The parsed href is parsed again by the built-in parser: what the record says is what a fresh parse says.
  if (new URL(href).origin !== uOrigin) return "origin";
  if (target.origin !== origin || uOrigin !== origin || protocol !== "https:") return "origin";
  if (f.username !== "" || f.password !== "") return "userinfo";
  if (hash !== "" || href.includes("#")) return "fragment";
  if (!pathname.startsWith("/")) return "path";
  const parsed = { href, pathname, search };
  const refusal = kind === "net" ? netRefusal(segments, query, parsed) : operationRefusal(segments, query, parsed);
  if (refusal !== null) return refusal;
  if (href !== url) return "identity";
  const snapshot: Snapshot = Object.freeze({ integration, origin, href, method, body: body === undefined ? undefined : copyBytes(body) });
  matchedComposed.add(composed);
  const matched = Object.freeze({ origin, href }) as unknown as MatchedTarget;
  records.set(matched, snapshot);
  return matched;
}

type Parsed = { readonly href: string; readonly pathname: string; readonly search: string };

/** A connector operation: every segment and query pair, in the one encoded spelling, equal to the composed one, in order. */
function operationRefusal(want: readonly string[], wantQuery: ReadonlyArray<readonly [string, string]>, u: Parsed): MatchRefusal | null {
  const segments = u.pathname.slice(1).split("/");
  if (segments.length !== want.length || segments.some((s, i) => !SEGMENT.test(s) || s !== want[i])) return "path";
  if (wantQuery.length === 0) return u.search !== "" || u.href.endsWith("?") ? "query" : null;
  const pairs = u.search.slice(1).split("&");
  if (!u.search.startsWith("?") || pairs.length !== wantQuery.length) return "query";
  const seen = new Set<string>();
  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i] as string;
    const eq = pair.indexOf("=");
    if (eq <= 0 || pair.indexOf("=", eq + 1) !== -1) return "query";
    const [key, value] = [pair.slice(0, eq), pair.slice(eq + 1)];
    const [wantKey, wantValue] = wantQuery[i] as readonly [string, string];
    if (seen.has(key) || key !== wantKey || value !== wantValue || !SEGMENT.test(value)) return "query";
    seen.add(key);
  }
  return null;
}

/** An `axis.net/1` path: the parsed path and query are exactly the composed text. */
function netRefusal(segments: readonly string[], query: ReadonlyArray<readonly [string, string]>, u: Parsed): MatchRefusal | null {
  if (u.pathname !== `/${segments.join("/")}`) return "path";
  const want = query.length === 0 ? "" : `?${query[0]?.[1] ?? ""}`;
  if (u.search !== want || (want === "" && u.href.endsWith("?"))) return "query";
  return null;
}

/** True for a MatchedTarget this module issued and that has not been authorized yet. */
export function isMatchedTarget(value: unknown): value is MatchedTarget {
  return typeof value === "object" && value !== null && records.has(value);
}

interface Secret {
  readonly value: string;
  readonly integration: string;
  readonly origin: string;
}
const secrets = new WeakMap<Credential, Secret>();
const HIDDEN = "[credential]";

/**
 * An opaque credential, BOUND to one integration and one origin: the header value (for example `Bearer <token>`) is held
 * in a module-private map. Every way of turning it into text (`String`, a template, `JSON.stringify`, `util.inspect`)
 * gives `[credential]`; the value leaves only through `authorize` and `authorizationOf`.
 */
export class Credential {
  constructor(headerValue: string, binding: { readonly integration: string; readonly origin: string }) {
    if (typeof headerValue !== "string" || headerValue.length === 0 || headerValue.length > 8192 || /[^\x20-\x7e]/.test(headerValue)) throw new CredentialError("credential_invalid");
    const integration: unknown = binding?.integration;
    const origin: unknown = binding?.origin;
    if (typeof integration !== "string" || integration.length === 0 || !originSchema.safeParse(origin).success) throw new CredentialError("credential_invalid");
    secrets.set(this, Object.freeze({ value: headerValue, integration, origin: origin as string }));
    Object.freeze(this);
  }
  toString(): string {
    return HIDDEN;
  }
  toJSON(): string {
    return HIDDEN;
  }
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return HIDDEN;
  }
}

export class CredentialError extends Error {
  constructor(readonly reason: "credential_invalid" | "not_matched" | "credential_mismatch" | "not_authorized") {
    super(
      reason === "not_matched" ? "a credential is attached only to a matched target"
      : reason === "credential_mismatch" ? "the credential belongs to another integration or origin"
      : reason === "not_authorized" ? "the request carries no credential"
      : "the credential is not a valid header value",
    );
    this.name = "CredentialError";
  }
}

/** What the egress client is handed: the matched URL, the method and the body, all from the match-time snapshot. */
export interface AuthorizedRequest {
  readonly method: Method;
  readonly url: string;
  readonly origin: string;
  readonly integration: string;
  readonly body: Uint8Array | undefined;
}

const authorizations = new WeakMap<object, string>();

/**
 * Attaches the credential to an unspent MatchedTarget, spending it. Refused: anything else (`not_matched`), and a credential
 * bound to another integration or origin (`credential_mismatch`). The result is built from the snapshot only.
 */
export function authorize(matched: MatchedTarget, credential: Credential): AuthorizedRequest {
  const snap = typeof matched === "object" && matched !== null ? records.get(matched) : undefined;
  if (snap === undefined) throw new CredentialError("not_matched");
  const secret = typeof credential === "object" && credential !== null ? secrets.get(credential) : undefined;
  if (secret === undefined) throw new CredentialError("credential_invalid");
  if (secret.integration !== snap.integration || secret.origin !== snap.origin) throw new CredentialError("credential_mismatch");
  // The snapshot's URL must be ON its origin, by a fresh parse: the credential goes to the origin it is bound to or nowhere.
  if (new URL(snap.href).origin !== snap.origin) throw new CredentialError("credential_mismatch");
  records.delete(matched);
  const request: AuthorizedRequest = Object.freeze({
    method: snap.method, url: snap.href, origin: snap.origin, integration: snap.integration,
    body: snap.body === undefined ? undefined : copyBytes(snap.body),
  });
  authorizations.set(request, secret.value);
  return request;
}

/** The Authorization header value of an AuthorizedRequest: the egress client's one reader (`not_authorized` otherwise). */
export function authorizationOf(request: AuthorizedRequest): string {
  const value = typeof request === "object" && request !== null ? authorizations.get(request) : undefined;
  if (value === undefined) throw new CredentialError("not_authorized");
  return value;
}
