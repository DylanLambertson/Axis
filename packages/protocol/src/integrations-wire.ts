// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { z } from "zod";

/*
 * The shared pieces of `axis.integrations/1` and `axis.net/1` (ticket PV-N1a, ADR 0009 decisions 1 to 4,
 * `docs/design/integrations-contract.md`). Nothing here names a URL, a header, a cookie or a credential: a caller names an
 * integration and an operation, or an origin and a composed path, and the daemon builds the request.
 */

/** The wire caps of the egress client (ADR 0009 decision 4). They are the daemon's limits on the service's own bytes, not the protocol's. */
export const INTEGRATION_REQUEST_MAX_BYTES = 1_048_576;
export const INTEGRATION_RESPONSE_MAX_BYTES = 4_194_304;
export const INTEGRATION_RESPONSE_MAX_DEPTH = 64;
export const INTEGRATION_RESPONSE_HEADERS_MAX_BYTES = 16_384;

/** What a reply carries to the caller: a typed value the connector's schema produced, inside the protocol's own bounds (nesting 16 with the envelope). */
export const RESULT_MAX_DEPTH = 12;
export const RESULT_STRING_CHARS = 65_536;
export const RESULT_ARRAY_ITEMS = 1_000;
export const RESULT_OBJECT_KEYS = 256;

/** The most arguments an operation takes, and the longest text argument. */
export const ARGS_MAX_KEYS = 32;
export const ARG_STRING_CHARS = 65_536;
export const MAX_INTEGRATIONS = 64;
export const MAX_OPERATIONS = 128;
export const MAX_ORIGINS = 8;
export const MAX_SCOPES = 32;

/** An integration: lower-case, starts with a letter. The vault entry is `integration:<id>`. */
export const integrationIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
/** One operation of a connector's closed set. */
export const operationIdSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
/** A granted or declared scope as the service names it: one token, never free text. */
export const scopeSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:._-]{0,63}$/);

/**
 * An HTTPS origin in punycode (ADR 0009 decision 4): lower-case, a registrable name with a top-level label that has a
 * letter, no port, userinfo, path, trailing dot or bracket. So no IP literal in any spelling (`127.0.0.1`, `2130706433`,
 * `0x7f.1`, `127.1`, `[::1]`) and no non-punycode host can be written. The daemon's address checks still run on the
 * resolved addresses.
 */
const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const TLD = "(?:[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?|xn--[a-z0-9-]{1,59})";
const ORIGIN = new RegExp(`^https://(?:${LABEL}\\.)+${TLD}$`);
export const originSchema = z
  .string()
  .max(262)
  .regex(ORIGIN)
  .refine((o) => o.length - "https://".length <= 253, "host too long");

// ---- the composed path of axis.net/1 (ADR 0009 decision 1) ----

const PATH_CHARS = /^\/[A-Za-z0-9\-._~!$&'()*+,;=:@%/?]*$/;
/** A dot segment in any spelling: `.`, `..`, `%2e`, `%2E` and mixes, between slashes or at the end of the path part. */
const DOT_SEGMENT = /(?:^|\/)(?:\.|%2e){1,2}(?=\/|$)/i;

/**
 * A request path with its query. Refused: any character outside the unreserved, sub-delimiter and `:@%/?` set (so no
 * control character, CR, LF, space, `\`, `#`, quote or non-ASCII character); a malformed percent escape; `%2f` and `%5c`
 * anywhere; an escaped control character; and a dot segment in the path part. At most 2,048 characters.
 */
export const netPathSchema = z
  .string()
  .max(2048)
  .regex(PATH_CHARS)
  .refine((p) => !/%(?![0-9a-fA-F]{2})/.test(p), "malformed percent escape")
  .refine((p) => !/%(?:2f|5c|[01][0-9a-f]|7f)/i.test(p), "an escaped slash, backslash or control character")
  .refine((p) => !DOT_SEGMENT.test(p.split("?", 1)[0] as string), "no dot segments")
  .refine((p) => p.split("?").length <= 2, "one query only");

/** The only methods `axis.net/1.request` allows. */
export const NET_METHODS = ["GET", "HEAD", "POST"] as const;
export const netMethodSchema = z.enum(NET_METHODS);

// ---- values ----

/** An argument or a body field: a bounded text without NUL, a safe integer or a boolean. No nesting, no null, no array. */
export const argValueSchema = z.union([
  z.string().max(ARG_STRING_CHARS).refine((t) => !t.includes("\u0000"), "no NUL"),
  z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
  z.boolean(),
]);

/**
 * Names that can never be an argument key, whatever their case, `_` or `-`: they would be a way to hand the daemon a URL,
 * a header or a credential. Defence in depth: the connector's own typed argument set is the authority and refuses any key
 * it does not declare.
 */
const RESERVED_ARG_KEYS: ReadonlySet<string> = new Set([
  "url", "uri", "href", "link", "host", "hostname", "origin", "baseurl", "header", "headers", "cookie", "cookies", "authorization",
  "auth", "bearer", "token", "accesstoken", "refreshtoken", "idtoken", "secret", "clientsecret", "password", "passwd", "credential",
  "credentials", "apikey", "key", "proxy", "redirect", "method", "path", "query",
]);
const ARG_KEY = /^[a-z][a-zA-Z0-9]{0,31}$/;
export const argKeySchema = z
  .string()
  .regex(ARG_KEY)
  .refine((k) => !RESERVED_ARG_KEYS.has(k.toLowerCase()), "a reserved name");

/** The typed arguments of one operation. The keys the operation takes are the connector's, not this schema's. */
export const argsSchema = z
  .record(argKeySchema, argValueSchema)
  .refine((a) => Object.keys(a).length <= ARGS_MAX_KEYS, "too many arguments");

/**
 * A bounded JSON value the daemon built from a connector's response schema or a plugin's body. Built to a fixed depth, so
 * there is no recursion to exhaust; the envelope's own walk bounds the whole message again.
 */
function jsonValue(depth: number): z.ZodType<unknown> {
  const leaf = z.union([z.string().max(RESULT_STRING_CHARS), z.number().finite(), z.boolean(), z.null()]);
  if (depth === 0) return leaf;
  const inner = jsonValue(depth - 1);
  return z.union([
    leaf,
    z.array(inner).max(RESULT_ARRAY_ITEMS),
    z.record(z.string().max(64), inner).refine((o) => Object.keys(o).length <= RESULT_OBJECT_KEYS, "too many keys"),
  ]);
}
export const resultValueSchema = jsonValue(RESULT_MAX_DEPTH);

/** A body a plugin sends: a JSON object (sent as `application/json`), shallower than a result. */
export const netBodySchema = jsonValue(6).refine((b) => typeof b === "object" && b !== null && !Array.isArray(b), "a JSON object");

/** Successful answers only: a `3xx` is `redirect_refused` and any other status is a closed error, never a body. */
export const okStatusSchema = z.number().int().min(200).max(299);
