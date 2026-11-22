// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

/*
 * The egress client's target rule (ticket PV-N1d slice A; ADR 0009 decision 4, TB24). A request URL is used only when it
 * is HTTPS to an origin in the declared set, written in exactly one spelling, so the origin match, the address check, SNI
 * and the certificate check all see the same host. Pure: the WHATWG `URL` parser and string checks, no socket.
 *
 * Refused, each with its own reason:
 * - not `https://`, or a URL the WHATWG parser refuses (`not_https`, `malformed`); a backslash in the authority, which
 *   the parser would read as a slash (`malformed`);
 * - userinfo, even empty (`userinfo`);
 * - an IP literal in any spelling: the parser turns the decimal, octal, hexadecimal and short IPv4 forms (`2130706433`,
 *   `0177.0.0.1`, `0x7f.1`, `127.1`) into dotted quads and keeps IPv6 bracketed, and both are refused (`ip_literal`);
 * - a trailing dot (`trailing_dot`), refused, never normalised;
 * - any other difference between the host or port as written and as parsed: upper case, Unicode instead of punycode, a
 *   percent escape, a default port written out (`not_canonical`);
 * - an origin (scheme, host and port) outside the declared set (`origin_not_declared`).
 */

export type TargetRefusal = "not_https" | "malformed" | "userinfo" | "ip_literal" | "trailing_dot" | "not_canonical" | "origin_not_declared";

export interface EgressTarget {
  readonly url: URL;
  /** The host as parsed (lower-case ASCII, punycode): what the lookup, SNI and the certificate check use. */
  readonly host: string;
  readonly port: number;
  /** `https://host` or `https://host:port`, as `URL.origin` writes it. */
  readonly origin: string;
}

const SCHEME = "https://";
const IPV4_DOTTED = /^[0-9]{1,3}(?:\.[0-9]{1,3}){3}$/;

/** The declared origins in `URL.origin` form; anything that is not a plain HTTPS origin is dropped (it can match nothing). */
export function declaredOrigins(origins: readonly string[]): ReadonlySet<string> {
  const out = new Set<string>();
  for (const o of origins) {
    let u: URL;
    try {
      u = new URL(o);
    } catch {
      continue;
    }
    if (u.protocol === "https:" && u.username === "" && u.password === "" && `${u.origin}` === o && !u.hostname.endsWith(".")) out.add(u.origin);
  }
  return out;
}

/** The checked target, or why the URL is refused. */
export function egressTarget(input: string, declared: ReadonlySet<string>): EgressTarget | TargetRefusal {
  if (!input.startsWith(SCHEME)) return "not_https";
  const authorityEnd = input.slice(SCHEME.length).search(/[/?#]/);
  const authority = authorityEnd < 0 ? input.slice(SCHEME.length) : input.slice(SCHEME.length, SCHEME.length + authorityEnd);
  if (authority.includes("\\")) return "malformed";
  if (authority.includes("@")) return "userinfo";
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return "malformed";
  }
  if (url.protocol !== "https:") return "not_https";
  if (url.username !== "" || url.password !== "") return "userinfo";
  const host = url.hostname;
  if (host.startsWith("[") || IPV4_DOTTED.test(host)) return "ip_literal";
  if (host.endsWith(".")) return "trailing_dot";
  if (authority !== (url.port === "" ? host : `${host}:${url.port}`)) return "not_canonical";
  if (!declared.has(url.origin)) return "origin_not_declared";
  return { url, host, port: url.port === "" ? 443 : Number(url.port), origin: url.origin };
}
