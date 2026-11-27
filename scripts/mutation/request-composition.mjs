// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
//
// Mutation run for PV-N1e request composition, the shared path table, the byte copy and the authorized send.
//
//   npm run build && node scripts/mutation/request-composition.mjs "$PWD"
//
// Each mutant edits ONE compiled file under dist (or a lint script), runs the tests that must catch it, and restores the
// file. A mutant whose anchor text is no longer found is STALE and fails the run, so the list keeps up with the code. Lines
// starting `// equivalent:` record a mutant that cannot change behaviour, and why. Not part of the gate: run it after a
// change to these files and state the result in the review.
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const root = process.argv[2];
const D = `${root}/packages/daemon-host/dist`;
const F = { c: `${D}/src/net/compose-request.js`, u: `${D}/src/net/url-pattern.js`, p: `${root}/packages/protocol/dist/src/integrations-wire.js`, b: `${D}/src/net/bytes.js`, k: `${D}/src/net/egress-client.js`, l: `${D}/src/net/egress-limits.js` };
const NET = ["compose-request", "url-pattern", "compose-property", "net-compose"].map((n) => `${D}/test/net/${n}.test.js`);
const EGRESS = ["bytes", "egress-hardening", "egress-limits", "egress-client", "egress-authorized"].map((n) => `${D}/test/net/${n}.test.js`);
const T = { c: NET, u: [...NET, `${D}/test/net/egress-authorized.test.js`], p: [...NET, `${root}/packages/protocol/dist/test/contracts-integrations.test.js`], b: [...EGRESS, ...NET], k: EGRESS, l: EGRESS };
const M = [
  ["c", "encoder sub-delims", ".replace(/[!'()*]/g,", ".replace(/[!]/g,"],
  ["c", "encoder hex case", "toString(16).toUpperCase()", "toString(16)"],
  ["c", "separator /", "const SEPARATOR = /[/?#\\\\;]/;", "const SEPARATOR = /[?#\\\\;]/;"],
  ["c", "separator ;", "const SEPARATOR = /[/?#\\\\;]/;", "const SEPARATOR = /[/?#\\\\]/;"],
  ["c", "separator backslash", "const SEPARATOR = /[/?#\\\\;]/;", "const SEPARATOR = /[/?#;]/;"],
  ["c", "C1 controls", "\\u0000-\\u001f\\u007f-\\u009f", "\\u0000-\\u001f\\u007f"],
  ["c", "bidi controls", "\\u202a-\\u202e", "\\u202a"],
  // equivalent: the direct dot-segment test is a fast path; the normalisation rule refuses "." and ".." too
  ["c", "empty value", "if (text.length === 0)", "if (false)"],
  ["c", "non-ascii", "if (type.kind !== \"text\" && /[^\\x20-\\x7e]/.test(text))", "if (false)"],
  ["c", "lone surrogate", "if (/[\\ud800-\\udfff]/.test(", "if (false && /[\\ud800-\\udfff]/.test("],
  ["c", "byte cap", "byteLength > MAX_VALUE_BYTES", "byteLength > MAX_VALUE_BYTES + 1"],
  ["c", "byte not char", "new TextEncoder().encode(text).byteLength > MAX_VALUE_BYTES", "text.length > MAX_VALUE_BYTES"],
  ["c", "id pattern", "if (type.kind === \"id\" && !(type.pattern ?? DEFAULT_ID).test(text))", "if (false)"],
  ["c", "int range", "(type.min !== undefined && value < type.min)", "false"],
  ["c", "int safe", "!Number.isSafeInteger(value) ||", ""],
  ["c", "enum member", "if (type.kind === \"enum\" && !type.values.includes(text))", "if (false)"],
  ["c", "unknown argument", "if (!used.has(k))", "if (false)"],
  ["c", "missing argument", "if (!has && required)", "if (false)"],
  ["c", "own property", "Object.prototype.hasOwnProperty.call(args, name)", "name in args"],
  ["c", "path re-check", "if (netPathRefusal(path) !== null)", "if (false)"],
  ["c", "origin check", "if (!originSchema.safeParse(origin).success)\n        throw new CompositionError(\"origin_refused\");\n    const used", "const used"],
  ["c", "template check", "if (templateProblem(t) !== null)", "if (false)"],
  ["c", "literal check", "if (!UNRESERVED_TOKEN.test(part.literal) || DOT_SEGMENT.test(part.literal))", "if (false)"],
  ["c", "method set", "new Set([\"GET\", \"HEAD\", \"POST\"])", "new Set([\"GET\", \"HEAD\", \"POST\", \"PUT\"])"],
  ["c", "query key", "if (!/^[A-Za-z0-9_.~-]{1,64}$/.test(q.key) || keys.has(q.key))", "if (keys.has(q.key))"],
  ["c", "body on read", "if (t.body !== undefined && (t.method === \"GET\" || t.method === \"HEAD\"))", "if (false)"],
  ["c", "id pattern anchored", "(!type.pattern.source.startsWith(\"^\") || !type.pattern.source.endsWith(\"$\") || type.pattern.flags.includes(\"g\"))", "false"],
  ["c", "net read methods", "if (!NET_READ_METHODS.includes(req.method))", "if (false)"],
  ["c", "net body", "if (!netBodySchema.safeParse(req.body).success)", "if (false)"],
  ["c", "net path", "if (typeof path !== \"string\" || netPathRefusal(path) !== null || CONTROL.test(path))", "if (typeof path !== \"string\")"],
  ["u", "target shape", "if (!(u instanceof URL) || typeof target.origin !== \"string\")", "if (false)"],
  ["u", "single match", "if (matchedComposed.has(composed))", "if (false)"],
  ["u", "composed shape", "if (typeof integration !== \"string\" || typeof url !== \"string\" || !Array.isArray(segments) || !Array.isArray(query) || (body !== undefined && !isBytes(body)))", "if (false)"],
  ["u", "origin", "if (target.origin !== origin || uOrigin !== origin || protocol !== \"https:\")", "if (false)"],
  ["u", "userinfo", "if (f.username !== \"\" || f.password !== \"\")", "if (false)"],
  ["u", "fragment", "if (hash !== \"\" || href.includes(\"#\"))", "if (hash !== \"\")"],
  ["u", "segment spelling", "!SEGMENT.test(s) || s !== want[i]", "s !== want[i]"],
  ["u", "segment equality", "!SEGMENT.test(s) || s !== want[i]", "!SEGMENT.test(s)"],
  ["u", "segment count", "segments.length !== want.length || ", ""],
  ["u", "empty query", "u.search !== \"\" || u.href.endsWith(\"?\") ? \"query\" : null", "u.search !== \"\" ? \"query\" : null"],
  ["u", "pair count", "!u.search.startsWith(\"?\") || pairs.length !== wantQuery.length", "!u.search.startsWith(\"?\")"],
  ["u", "key order", "key !== wantKey || ", ""],
  ["u", "value equality", "value !== wantValue || ", ""],
  ["u", "duplicate key", "seen.has(key) || ", ""],
  ["u", "net path", "if (u.pathname !== `/${segments.join(\"/\")}`)", "if (false)"],
  ["u", "net query", "if (u.search !== want || (want === \"\" && u.href.endsWith(\"?\")))", "if (false)"],
  ["u", "identity", "if (href !== url)", "if (false)"],
  ["u", "snapshot body copy", "body: body === undefined ? undefined : copyBytes(body) });", "body });"],
  ["u", "mark composed matched", "matchedComposed.add(composed);", ""],
  ["u", "brand issue", "records.set(matched, snapshot);", ""],
  ["u", "single use", "records.delete(matched);", ""],
  ["u", "binding integration", "secret.integration !== snap.integration || ", ""],
  ["u", "binding origin", " || secret.origin !== snap.origin", ""],
  ["u", "credential toString", "toString() {\n        return HIDDEN;", "toString() {\n        return secrets.get(this).value;"],
  ["u", "credential toJSON", "toJSON() {\n        return HIDDEN;", "toJSON() {\n        return secrets.get(this).value;"],
  ["u", "credential inspect", "[Symbol.for(\"nodejs.util.inspect.custom\")]() {\n        return HIDDEN;", "[Symbol.for(\"nodejs.util.inspect.custom\")]() {\n        return secrets.get(this).value;"],
  ["u", "credential value check", "/[^\\x20-\\x7e]/.test(headerValue)", "false"],
  ["u", "credential binding check", "typeof integration !== \"string\" || integration.length === 0 || !originSchema.safeParse(origin).success", "false"],
  ["u", "header as property", "authorizations.set(request, secret.value);\n    return request;", "authorizations.set(request, secret.value);\n    return { ...request, authorization: secret.value };"],
  ["u", "reader check", "if (value === undefined)\n        throw new CredentialError(\"not_authorized\");", ""],
  ["c", "percent refused", "if (CONTROL.test(text) || SEPARATOR.test(text) || PERCENT.test(text))", "if (CONTROL.test(text) || SEPARATOR.test(text))"],
  ["c", "path confusables", "PATH_CONFUSABLE.test(text) || DEFAULT_IGNORABLE.test(text)", "DEFAULT_IGNORABLE.test(text)"],
  ["c", "integration checked", "if (typeof integration !== \"string\" || !INTEGRATION.test(integration))\n        throw new CompositionError(\"integration_refused\");\n    if (!originSchema.safeParse(origin).success)\n        throw new CompositionError(\"origin_refused\");\n    const used", "const used"],
  ["c", "net integration checked", "if (typeof integration !== \"string\" || !INTEGRATION.test(integration))\n        throw new CompositionError(\"integration_refused\");\n    if (!originSchema.safeParse(origin).success)\n        throw new CompositionError(\"origin_refused\");\n    if (typeof path", "if (typeof path"],
  ["c", "integration recorded", "kind: \"operation\", integration, method", "kind: \"operation\", integration: \"gh\", method"],
  ["p", "table: %25 in path", "[\"an escaped percent sign in the path\", (p) => /%25/i.test(p.split(\"?\", 1)[0])],", ""],
  ["b", "isBytes tag", "Reflect.apply(TAG, value, []) === \"Uint8Array\"", "value instanceof Uint8Array"],
  ["b", "intrinsic length", "const length = Reflect.apply(BYTE_LENGTH, value, []);", "const length = value.byteLength;"],
  // equivalent: the target array is our own, so its set is the intrinsic one (the code now says so)
  ["b", "a copy", "const out = new Uint8Array(length);\n    out.set(value);", "const out = value;"],
  // equivalent: a Proxy body passing instanceof makes the intrinsic copy throw, which the client makes request_refused before a slot
  ["k", "content length from the copy", "sent[\"content-length\"] = String(copy.byteLength);", "sent[\"content-length\"] = String(body.byteLength);"],
  ["k", "client copies by slots", "const bytes = body === undefined ? undefined : copyBytes(body);", "const bytes = body === undefined ? undefined : body.slice();"],
  ["l", "name checked before lower-casing", "if (typeof name !== \"string\" || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name))\n            throw new EgressError(\"header_refused\");", "if (false)\n            throw new EgressError(\"header_refused\");"],
  ["u", "matcher uses isBytes", " || (body !== undefined && !isBytes(body))", ""],
  ["u", "intrinsic URL getters", "Reflect.apply(URL_GET[f], u, [])", "u[f]"],
  // equivalent: the built-in getters read the parsed record, so a fresh parse of its href gives the same origin; defence in depth
  ["u", "https only", "|| protocol !== \"https:\")", "|| false)"],
  ["u", "credential origin exact", "secret.origin !== snap.origin)\n        throw", "!snap.origin.startsWith(secret.origin))\n        throw"],
  ["u", "credential origin schema", "!originSchema.safeParse(origin).success", "typeof origin !== \"string\" || !origin.startsWith(\"https://\")"],
  ["c", "normalisation rule", "|| normalisesToDanger(text)))", "))"],
  // equivalent: the all-code-point scan shows NFKD alone catches the same set today; both kept against Unicode changes
  // equivalent: the all-code-point scan shows NFKC alone catches the same set today; both kept against Unicode changes
  ["c", "normalised percent", "SEPARATOR.test(n) || PERCENT.test(n) || CONTROL.test(n) || DOT_SEGMENT.test(n)", "SEPARATOR.test(n) || CONTROL.test(n) || DOT_SEGMENT.test(n)"],
  ["c", "normalised dot segment", "SEPARATOR.test(n) || PERCENT.test(n) || CONTROL.test(n) || DOT_SEGMENT.test(n)", "SEPARATOR.test(n) || PERCENT.test(n) || CONTROL.test(n)"],
  // equivalent: authorize's fresh-parse recheck of the snapshot (match already refuses a record whose fresh parse differs); defence in depth
  ["l", "authorization owned", "\"accept-encoding\", \"authorization\",", "\"accept-encoding\","],
  ["u", "take is single-use", "const value = authorizationOf(request);\n    authorizations.delete(request);", "const value = authorizationOf(request);"],
  ["k", "forgery refused", "        catch {\n            throw new EgressError(\"not_authorized\");\n        }", "        catch {\n            value = \"\";\n        }"],
  ["k", "credential attached", "snap.headers.authorization = value;", ""],
  ["c", "default ignorable", "|| DEFAULT_IGNORABLE.test(text) ", ""],
  // equivalent: sendAuthorized's url/origin recheck (an AuthorizedRequest's url is a parsed href that egressTarget gives back unchanged); defence in depth
  ["p", "table: dot segment", "[\"no dot segments\", (p) => DOT_SEGMENT.test(p.split(\"?\", 1)[0])],", ""],
  ["p", "table: %3b", "[\"an escaped path-parameter separator\", (p) => /%3b/i.test(p)],", ""],
  ["p", "table: one query", "[\"one query only\", (p) => p.split(\"?\").length > 2],", ""],
  ["p", "schema uses table", "if (reason !== null)\n        ctx.addIssue", "if (false)\n        ctx.addIssue"],
];
const orig = Object.fromEntries(Object.entries(F).map(([k, f]) => [k, readFileSync(f, "utf8")]));
let bad = 0;
try {
  for (const [f, name, from, to] of M) {
    const n = orig[f].split(from).length - 1;
    if (n !== 1) { console.log(`STALE(${n}) ${name}`); bad++; continue; }
    writeFileSync(F[f], orig[f].replace(from, to));
    const r = spawnSync(process.execPath, ["--test", "--test-timeout=60000", ...T[f]], { cwd: root, encoding: "utf8", timeout: 300_000 });
    writeFileSync(F[f], orig[f]);
    if (r.status === 0) bad++;
    console.log(`${r.status !== 0 ? "killed " : "SURVIVED"} ${name}`);
  }
} finally { for (const k of Object.keys(F)) writeFileSync(F[k], orig[k]); }
console.log(`${M.length} mutants, ${bad} survived or stale`);
process.exit(bad ? 1 : 0);
