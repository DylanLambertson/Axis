// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

import { netBodySchema, netPathRefusal, NET_READ_METHODS, originSchema } from "@axis/protocol";

/*
 * Request composition (ticket PV-N1e; ADR 0009 decision 3, INT-6). An operation fixes its method, its path template and
 * its query keys; each argument is a typed value placed into ONE named path segment or ONE declared query key, refused
 * BEFORE encoding when it holds a separator, a dot segment, an encoded separator or a control character, then encoded once
 * by the one encoder below. The composed path is re-checked by the contract's own refusal table (`netPathRefusal`, imported
 * from @axis/protocol, never copied). Pure: no socket, no credential. url-pattern.ts matches the parsed result before any
 * credential is attached.
 *
 * Unicode (decided here): no normalisation. A path or query value is ASCII unless its type is `text`; a `text` value is
 * UTF-8 percent-encoded once. A lone surrogate is refused. Every placeholder value is at most 256 UTF-8 bytes.
 *
 * No `%` at all in a placeholder value (review 1 SF3): a split escape such as `%2%65` is no escape to a strict decoder but
 * `%2e` to a lenient one, so the only safe value holds no percent sign; then the encoded value decodes to the same text
 * however many times it is decoded. A PATH segment of type `text` also refuses the dot and slash look-alikes (fullwidth,
 * ideographic, small and leader forms) that a normalising server could read as `.`, `..` or `/` (review 1 nit b).
 */

export type ValueType =
  | { readonly kind: "int"; readonly min?: number; readonly max?: number }
  | { readonly kind: "enum"; readonly values: readonly string[] }
  /** An identifier: ASCII, matching `pattern` (anchored) when given, else letters, digits and `-._~`. */
  | { readonly kind: "id"; readonly pattern?: RegExp }
  /** Free text, Unicode allowed, encoded once as UTF-8. */
  | { readonly kind: "text" };

export type PathPart = { readonly literal: string } | { readonly arg: string; readonly type: ValueType };
export interface QueryParam {
  readonly key: string;
  readonly arg: string;
  readonly type: ValueType;
  readonly required: boolean;
}
export interface BodyField {
  readonly name: string;
  readonly arg: string;
  readonly kind: "text" | "int" | "bool";
  readonly required: boolean;
}
/** The egress client's closed method set (PV-N1d `EGRESS_METHODS`): an operation is a GET, a HEAD or a POST. */
export type Method = "GET" | "HEAD" | "POST";

export interface OperationTemplate {
  readonly method: Method;
  readonly path: readonly PathPart[];
  readonly query?: readonly QueryParam[];
  readonly body?: readonly BodyField[];
}

export type ArgValue = string | number | boolean;

export interface ComposedRequest {
  /** The integration (or plugin) the request is for: a credential attaches only to a request of its own integration. */
  readonly integration: string;
  /** `operation`: from a connector's template (segments and query pairs checked one by one); `net`: an `axis.net/1` path, checked whole. */
  readonly kind: "operation" | "net";
  readonly method: Method;
  readonly origin: string;
  /** Origin, encoded path and query: exactly what the WHATWG parser must give back (url-pattern.ts). */
  readonly url: string;
  /** The encoded path segments and query pairs, in template order, for the match. */
  readonly segments: readonly string[];
  readonly query: ReadonlyArray<readonly [string, string]>;
  readonly body: Uint8Array | undefined;
}

export const COMPOSE_REFUSALS = [
  "template_invalid", "integration_refused", "origin_refused", "argument_unknown", "argument_missing", "argument_type", "argument_refused", "argument_too_long",
  "non_ascii", "path_refused", "method_refused", "body_refused",
] as const;
export type ComposeRefusal = (typeof COMPOSE_REFUSALS)[number];

/** A closed composition error: a reason only, never an argument, an origin or a path. */
export class CompositionError extends Error {
  constructor(readonly reason: ComposeRefusal) {
    super(`the request could not be composed (${reason})`);
    this.name = "CompositionError";
  }
}

export const MAX_VALUE_BYTES = 256;
const UNRESERVED_TOKEN = /^[A-Za-z0-9\-._~]+$/;
const DEFAULT_ID = /^[A-Za-z0-9\-._~]+$/;
const METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "POST"]);
// C0, DEL and C1 controls; the bidi and line separators that render text misleadingly are refused in a URL value too.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
// `;` too: encoded it is `%3B`, which the contract refuses anywhere (a path parameter some servers strip), so it is refused here, before encoding.
const SEPARATOR = /[/?#\\;]/;
const PERCENT = /%/;
// Audit C I1: the middle dot, Greek ano teleia, Arabic and Syriac full stops and the Lisu tone mark look like `.` and no
// normalisation maps them to it, so normalisesToDanger cannot see them.
const PATH_CONFUSABLE = /[\u00b7\u0387\u06d4\u0701\ua4f8\u2024\u2044\u2215\u2216\u29f5\u29f8\u3002\ufe52\ufe68\uff0e\uff0f\uff3c\uff61]/;
const INTEGRATION = /^[a-z][a-z0-9:._-]{0,63}$/;

/**
 * True when a normalising server could read a path value as something else (review 2 SF3, a RULE, not a list): its NFKC or
 * NFKD form holds a separator, a percent sign or a control character, or is a dot segment. So U+2025 (".." once
 * normalised), U+FE30, U+FF0E, U+2100 ("a/c") and the like are refused whatever the list above says; the list keeps the
 * slash look-alikes that have no compatibility decomposition (U+2215, U+29F5 and others).
 */
/**
 * Unicode default-ignorable code points (zero-width space U+200B, soft hyphen U+00AD, the joiners, variation selectors and
 * others): invisible, and some servers strip them, so `.\u200b.` would be read as `..` (N1e review 3 nit 1). Refused in a
 * path value by the Unicode property, not a list.
 */
const DEFAULT_IGNORABLE = /\p{Default_Ignorable_Code_Point}/u;

/**
 * Invisible characters that are NOT default-ignorable (N1f review 1 nit 5), refused in a path value as the safe default:
 * every format character (Cf, U+13430 among them), every space separator but the ASCII space (Zs: U+00A0, U+2000 to
 * U+200A, U+202F, U+205F, U+3000), and the blank glyphs no Unicode property names (U+2800 BRAILLE PATTERN BLANK, U+1D159
 * MUSICAL SYMBOL NULL NOTEHEAD, U+16FE4 KHITAN SMALL SCRIPT FILLER). The ASCII space stays: a label name holds spaces.
 */
const INVISIBLE = /(?! )[\p{Cf}\p{Zs}\u2800\u{1d159}\u{16fe4}]/u; // by property; the lookahead keeps the ASCII space

/**
 * Code points with no fixed meaning (N1f nits review B): private use (Co) and unassigned (Cn, the noncharacters such as
 * U+FDD0 and U+FFFE included). A server or a later Unicode version may give them any reading, so a path value refuses them.
 */
const UNSETTLED = /[\p{Co}\p{Cn}]/u;
/** True when the value is a dot segment once its combining marks are dropped: `.` + U+0301 + `.` is `..` to a server that strips marks. */
const dotsWithMarks = (text: string): boolean => [text, text.normalize("NFKD")].some((t) => DOT_SEGMENT.test(t.replace(/\p{M}/gu, "")));

export function normalisesToDanger(text: string): boolean {
  return [text.normalize("NFKC"), text.normalize("NFKD")].some((n) => SEPARATOR.test(n) || PERCENT.test(n) || CONTROL.test(n) || DOT_SEGMENT.test(n));
}
const DOT_SEGMENT = /^\.{1,2}$/;

/** The one encoder: UTF-8, every byte outside the unreserved set as `%XX` with upper-case hex. Throws on a lone surrogate. */
export function encodeValue(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Why the template is unusable, or null. Checked on every composition, so a bad template composes nothing. */
export function templateProblem(t: OperationTemplate): string | null {
  if (!METHODS.has(t.method)) return "method";
  if (t.path.length === 0 || t.path.length > 32) return "path length";
  const args = new Set<string>();
  const arg = (name: string): boolean => /^[a-z][a-zA-Z0-9]{0,31}$/.test(name) && !args.has(name) && (args.add(name), true);
  for (const part of t.path) {
    if ("literal" in part) {
      if (!UNRESERVED_TOKEN.test(part.literal) || DOT_SEGMENT.test(part.literal)) return "literal";
    } else if (!arg(part.arg) || typeProblem(part.type)) return "path arg";
  }
  const keys = new Set<string>();
  for (const q of t.query ?? []) {
    if (!/^[A-Za-z0-9_.~-]{1,64}$/.test(q.key) || keys.has(q.key)) return "query key";
    keys.add(q.key);
    if (!arg(q.arg) || typeProblem(q.type)) return "query arg";
  }
  if (t.body !== undefined && (t.method === "GET" || t.method === "HEAD")) return "body on a read";
  const names = new Set<string>();
  for (const f of t.body ?? []) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(f.name) || names.has(f.name) || !arg(f.arg)) return "body field";
    names.add(f.name);
  }
  return null;
}

function typeProblem(type: ValueType): boolean {
  if (type.kind === "enum") return type.values.length === 0 || type.values.some((v) => !UNRESERVED_TOKEN.test(v) || DOT_SEGMENT.test(v));
  if (type.kind === "id") return type.pattern !== undefined && (!type.pattern.source.startsWith("^") || !type.pattern.source.endsWith("$") || type.pattern.flags.includes("g"));
  if (type.kind === "int") return (type.min !== undefined && !Number.isSafeInteger(type.min)) || (type.max !== undefined && !Number.isSafeInteger(type.max));
  return type.kind !== "text";
}

/** The value as the text to encode, after its type and every refusal that runs BEFORE encoding. */
export function placeholderText(value: ArgValue, type: ValueType, inPath: boolean): string {
  let text: string;
  if (type.kind === "int") {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || (type.min !== undefined && value < type.min) || (type.max !== undefined && value > type.max)) throw new CompositionError("argument_type");
    text = String(value);
  } else {
    if (typeof value !== "string") throw new CompositionError("argument_type");
    text = value;
    if (type.kind === "enum" && !type.values.includes(text)) throw new CompositionError("argument_type");
  }
  if (text.length === 0) throw new CompositionError("argument_refused");
  if (CONTROL.test(text) || SEPARATOR.test(text) || PERCENT.test(text)) throw new CompositionError("argument_refused");
  if (inPath && (DOT_SEGMENT.test(text) || PATH_CONFUSABLE.test(text) || DEFAULT_IGNORABLE.test(text) || INVISIBLE.test(text) || UNSETTLED.test(text) || dotsWithMarks(text) || normalisesToDanger(text))) throw new CompositionError("argument_refused");
  if (type.kind !== "text" && /[^\x20-\x7e]/.test(text)) throw new CompositionError("non_ascii");
  if (/[\ud800-\udfff]/.test(text.replace(/[\ud800-\udbff][\udc00-\udfff]/g, ""))) throw new CompositionError("argument_refused"); // a lone surrogate
  if (new TextEncoder().encode(text).byteLength > MAX_VALUE_BYTES) throw new CompositionError("argument_too_long");
  if (type.kind === "id" && !(type.pattern ?? DEFAULT_ID).test(text)) throw new CompositionError("argument_type");
  return text;
}

function bodyValue(value: ArgValue, kind: BodyField["kind"]): ArgValue {
  const ok = kind === "text" ? typeof value === "string" : kind === "int" ? typeof value === "number" && Number.isSafeInteger(value) : typeof value === "boolean";
  if (!ok) throw new CompositionError("argument_type");
  return value;
}

/** The request the template and arguments describe, or a CompositionError. Every argument must be one the template takes. */
export function composeRequest(t: OperationTemplate, integration: string, origin: string, args: Readonly<Record<string, ArgValue>>): ComposedRequest {
  if (templateProblem(t) !== null) throw new CompositionError("template_invalid");
  if (typeof integration !== "string" || !INTEGRATION.test(integration)) throw new CompositionError("integration_refused");
  if (!originSchema.safeParse(origin).success) throw new CompositionError("origin_refused");
  const used = new Set<string>();
  const take = (name: string, required: boolean): ArgValue | undefined => {
    used.add(name);
    const has = Object.prototype.hasOwnProperty.call(args, name);
    if (!has && required) throw new CompositionError("argument_missing");
    return has ? args[name] : undefined;
  };
  const segments = t.path.map((part) => ("literal" in part ? part.literal : encodeValue(placeholderText(take(part.arg, true) as ArgValue, part.type, true))));
  const query: Array<readonly [string, string]> = [];
  for (const q of t.query ?? []) {
    const v = take(q.arg, q.required);
    if (v !== undefined) query.push([q.key, encodeValue(placeholderText(v, q.type, false))]);
  }
  let body: Uint8Array | undefined;
  if (t.body !== undefined) {
    const fields: Record<string, ArgValue> = {};
    for (const f of t.body) {
      const v = take(f.arg, f.required);
      if (v !== undefined) fields[f.name] = bodyValue(v, f.kind);
    }
    body = new TextEncoder().encode(JSON.stringify(fields));
  }
  for (const k of Object.keys(args)) if (!used.has(k)) throw new CompositionError("argument_unknown");
  const path = `/${segments.join("/")}${query.length === 0 ? "" : `?${query.map(([k, v]) => `${k}=${v}`).join("&")}`}`;
  if (netPathRefusal(path) !== null) throw new CompositionError("path_refused");
  return Object.freeze({ kind: "operation" as const, integration, method: t.method, origin, url: `${origin}${path}`, segments: Object.freeze(segments), query: Object.freeze(query), body });
}

/**
 * An `axis.net/1` request (ADR 0009 decision 1): a plugin's composed path to a granted origin. `read` is GET or HEAD with no
 * body; `send` is a POST with an optional JSON object body (the contract's netBodySchema). The path is judged by the
 * contract's own refusal table here too, and url-pattern.ts requires the parsed path and query to be exactly this text.
 */
export function composeNetRequest(integration: string, origin: string, path: string, req: { readonly kind: "read"; readonly method: string } | { readonly kind: "send"; readonly body?: unknown }): ComposedRequest {
  if (typeof integration !== "string" || !INTEGRATION.test(integration)) throw new CompositionError("integration_refused");
  if (!originSchema.safeParse(origin).success) throw new CompositionError("origin_refused");
  if (typeof path !== "string" || netPathRefusal(path) !== null || CONTROL.test(path)) throw new CompositionError("path_refused");
  let method: Method;
  let body: Uint8Array | undefined;
  if (req.kind === "read") {
    if (!(NET_READ_METHODS as readonly string[]).includes(req.method)) throw new CompositionError("method_refused");
    method = req.method as Method;
  } else {
    method = "POST";
    if (req.body !== undefined) {
      if (!netBodySchema.safeParse(req.body).success) throw new CompositionError("body_refused");
      body = new TextEncoder().encode(JSON.stringify(req.body));
    }
  }
  const [pathPart, queryPart] = path.split("?") as [string, string | undefined];
  const query = queryPart === undefined ? [] : [["", queryPart] as const];
  return Object.freeze({ kind: "net" as const, integration, method, origin, url: `${origin}${path}`, segments: Object.freeze(pathPart.slice(1).split("/")), query: Object.freeze(query), body });
}
