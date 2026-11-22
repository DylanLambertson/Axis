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
/**
 * A dot segment in any spelling: `.`, `..`, `%2e`, `%2E` and mixes, between slashes or at the end of the path part, and with
 * a path parameter (`..;`, `.;x`), which some servers strip before they normalise.
 */
const DOT_SEGMENT = /(?:^|\/)(?:\.|%2e){1,2}(?=[/;]|$)/i;

/**
 * A request path with its query. Refused: any character outside the unreserved, sub-delimiter and `:@%/?` set (so no
 * control character, CR, LF, space, `\`, `#`, quote or non-ASCII character); a malformed percent escape; `%2f` and `%5c`
 * anywhere; an escaped control character; a double-encoded dot, slash or backslash (`%252e`); an overlong UTF-8 lead byte
 * (`%c0`, `%c1`, `%e0%80`, `%f0%80`); `//` in the path part (a protocol-relative path would name another host if it were
 * resolved against the origin); and a dot segment in the path part. At most 2,048 characters. Control characters in a
 * path or query value are also refused where the daemon composes it (PV-N1f's composition test): this is the first fence.
 */
export const netPathSchema = z
  .string()
  .max(2048)
  .regex(PATH_CHARS)
  .refine((p) => !/%(?![0-9a-fA-F]{2})/.test(p), "malformed percent escape")
  .refine((p) => !/%(?:2f|5c|[01][0-9a-f]|7f)/i.test(p), "an escaped slash, backslash or control character")
  .refine((p) => !/%25(?:2e|2f|5c)/i.test(p), "a double-encoded dot, slash or backslash")
  .refine((p) => !/%(?:c0|c1|e0%80|f0%80)/i.test(p), "an overlong UTF-8 encoding")
  .refine((p) => !(p.split("?", 1)[0] as string).includes("//"), "no empty segment or protocol-relative path")
  .refine((p) => !DOT_SEGMENT.test(p.split("?", 1)[0] as string), "no dot segments")
  .refine((p) => p.split("?").length <= 2, "one query only");

/** `axis.net/1.read` allows `GET` and `HEAD`; `axis.net/1.send` is a `POST` and has no method field. */
export const NET_READ_METHODS = ["GET", "HEAD"] as const;
export const netReadMethodSchema = z.enum(NET_READ_METHODS);

// ---- values ----

/**
 * An argument or a body field: a bounded text without NUL, a safe integer or a boolean. No nesting, no null, no array. A
 * text may hold CR, LF and other controls (a comment body has newlines); the daemon refuses them in a value that goes into
 * a path segment or a query parameter (ADR 0009 decision 3: the PV-N1f composition test).
 */
export const argValueSchema = z.union([
  z.string().max(ARG_STRING_CHARS).refine((t) => !t.includes("\u0000"), "no NUL"),
  z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
  z.boolean(),
]);

/**
 * Names that can never be an argument key. A key is split into its camelCase words and refused when any word is one of
 * ANYWHERE (so `authToken`, `proxyUrl`, `redirectUri`, `setCookie`, `callbackUrl` all go), when two adjacent words join to a
 * COMPOUND (`apiKey`, `privateKey`, `sessionId`), or when the whole name is one of WHOLE (`key`, `path`, `query`, `method`,
 * `origin`, `host`: words a real argument may contain, as in `sortKey` or `filePath`). `author` is not `auth`. Defence in
 * depth: the connector's own typed argument set is the authority and refuses any key it does not declare.
 */
const ANYWHERE: ReadonlySet<string> = new Set([
  "url", "uri", "href", "link", "header", "headers", "cookie", "cookies", "auth", "authorization", "bearer", "token", "tokens", "secret",
  "secrets", "password", "passwd", "credential", "credentials", "proxy", "redirect", "jwt", "oauth",
]);
const COMPOUND: ReadonlySet<string> = new Set(["apikey", "privatekey", "accesskey", "signingkey", "secretkey", "sessionid", "clientid"]);
const WHOLE: ReadonlySet<string> = new Set(["key", "path", "query", "method", "origin", "host", "hostname", "baseurl"]);
const ARG_KEY = /^[a-z][a-zA-Z0-9]{0,31}$/;
function reservedKey(key: string): boolean {
  const words = key.split(/(?=[A-Z])/).map((w) => w.toLowerCase());
  if (words.some((w) => ANYWHERE.has(w))) return true;
  if (words.some((w, i) => i > 0 && COMPOUND.has((words[i - 1] as string) + w))) return true;
  return WHOLE.has(key.toLowerCase()) || COMPOUND.has(key.toLowerCase());
}
export const argKeySchema = z
  .string()
  .regex(ARG_KEY)
  .refine((k) => !reservedKey(k), "a reserved name");

/** A key `__proto__`, `constructor` or `prototype` is refused, never dropped: the values sent are exactly the values the caller passed. */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);
const recordKey = z.string().max(64).refine((k) => !FORBIDDEN_KEYS.has(k), "a forbidden key");
/**
 * zod's record skips an own `__proto__` key without looking at it (a silent drop: the values sent would differ from the
 * values the caller passed), so the check runs on the input first, then the record parses.
 */
const noForbiddenKeys = z.unknown().refine((o) => typeof o !== "object" || o === null || !Object.keys(o).some((k) => FORBIDDEN_KEYS.has(k)), "a forbidden key");

/** The typed arguments of one operation. The keys the operation takes are the connector's, not this schema's. */
export const argsSchema = noForbiddenKeys.pipe(
  z.record(argKeySchema, argValueSchema).refine((a) => Object.keys(a).length <= ARGS_MAX_KEYS, "too many arguments"),
);

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
    noForbiddenKeys.pipe(z.record(recordKey, inner).refine((o) => Object.keys(o).length <= RESULT_OBJECT_KEYS, "too many keys")),
  ]);
}
export const resultValueSchema = jsonValue(RESULT_MAX_DEPTH);

/** A body a plugin sends: a JSON object (sent as `application/json`), shallower than a result. */
export const netBodySchema = jsonValue(6).refine((b) => typeof b === "object" && b !== null && !Array.isArray(b), "a JSON object");

/** Successful answers only: a `3xx` is `redirect_refused` and any other status is a closed error, never a body. */
export const okStatusSchema = z.number().int().min(200).max(299);
