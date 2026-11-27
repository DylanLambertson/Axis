// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { COMPOSE_REFUSALS, composeNetRequest, composeRequest, CompositionError, encodeValue, MAX_VALUE_BYTES, type OperationTemplate, templateProblem } from "../../src/net/compose-request.js";
import { ISSUE, NAMED } from "./templates.js";

// PV-N1e: request composition (ADR 0009 decision 3). Every refusal runs BEFORE encoding and has its own case.

const ORIGIN = "https://api.example.com";
const BASE = { owner: "octo", repo: "hello.world", number: 42 };

const reason = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    assert.ok(e instanceof CompositionError, String(e));
    return e.reason;
  }
  return "composed";
};

test("a template and its arguments compose to one URL, segments and query in template order, encoded once", () => {
  const c = composeRequest(ISSUE, "gh", ORIGIN, { ...BASE, state: "open", perPage: 50, search: "a b&c=d+\u00e9" });
  assert.equal(c.url, `${ORIGIN}/repos/octo/hello.world/issues/42?state=open&per_page=50&q=a%20b%26c%3Dd%2B%C3%A9`);
  assert.deepEqual(c.segments, ["repos", "octo", "hello.world", "issues", "42"]);
  assert.deepEqual(c.query, [["state", "open"], ["per_page", "50"], ["q", "a%20b%26c%3Dd%2B%C3%A9"]]);
  assert.equal(c.method, "GET");
  assert.equal(c.body, undefined);
  assert.equal(composeRequest(ISSUE, "gh", ORIGIN, BASE).url, `${ORIGIN}/repos/octo/hello.world/issues/42`, "optional keys left out, no `?`");
  assert.ok(Object.isFrozen(c));
});

test("the one encoder: unreserved kept, everything else UTF-8 %XX in upper case, the sub-delimiters included", () => {
  assert.equal(encodeValue("AZaz09-._~"), "AZaz09-._~");
  assert.equal(encodeValue("!'()*"), "%21%27%28%29%2A");
  assert.equal(encodeValue(" &=+$,;:@[]"), "%20%26%3D%2B%24%2C%3B%3A%40%5B%5D");
  assert.equal(encodeValue("\u00e9\ud83d\ude00"), "%C3%A9%F0%9F%98%80");
  assert.throws(() => encodeValue("\ud800"), URIError);
});

test("a value with a separator, a control character or an encoded separator is refused before encoding, in a path or a query", () => {
  const bad = ["a/b", "a?b", "a#b", "a\\b", "a;b", "a\rb", "a\nb", "a\tb", "a\u0000b", "a\u007fb", "a\u0085b", "a\u2028b", "a\u202eb", "a\u2066b",
    "a%2eb", "a%2Eb", "a%2fb", "a%2Fb", "a%5cb", "a%3bb", "a%3Bb", "a%25b", "a%0ab", "a%0Db", "a%7fb", "a%1fb", "%2e%2e", ""];
  for (const v of bad) {
    assert.equal(reason(() => composeRequest(NAMED, "gh", ORIGIN, { name: v })), "argument_refused", `path ${JSON.stringify(v)}`);
    assert.equal(reason(() => composeRequest(ISSUE, "gh", ORIGIN, { ...BASE, search: v })), "argument_refused", `query ${JSON.stringify(v)}`);
  }
  for (const v of [".", ".."]) {
    assert.equal(reason(() => composeRequest(NAMED, "gh", ORIGIN, { name: v })), "argument_refused", `a dot segment ${v}`);
    assert.equal(reason(() => composeRequest(ISSUE, "gh", ORIGIN, { ...BASE, search: v })), "composed", `${v} is no segment in a query`);
  }
  for (const v of ["...", ".a", "a..b", "a.b~c-d_e"]) assert.equal(reason(() => composeRequest(NAMED, "gh", ORIGIN, { name: v })), "composed", v);
  // No percent sign at all (review 1 SF3): a split escape is no escape to a strict decoder but one to a lenient decoder.
  for (const v of ["100%", "a%41b", "%", "%2%65", "%2%66", "%5%63", "a%%2e", "%%"]) {
    assert.equal(reason(() => composeRequest(NAMED, "gh", ORIGIN, { name: v })), "argument_refused", `path ${v}`);
    assert.equal(reason(() => composeRequest(ISSUE, "gh", ORIGIN, { ...BASE, search: v })), "argument_refused", `query ${v}`);
  }
  // Dot and slash look-alikes in a text PATH segment (review 1 nit b); a query value may keep them.
  for (const v of ["\uff0e\uff0e", "a\uff0fb", "\u3002", "\uff61", "\u2024\u2024", "\ufe52", "a\u2215b", "a\u2044b", "a\uff3cb", "a\u29f5b", "a\u2216b", "a\ufe68b", "a\u29f8b"]) {
    assert.equal(reason(() => composeRequest(NAMED, "gh", ORIGIN, { name: v })), "argument_refused", `path ${JSON.stringify(v)}`);
    assert.equal(reason(() => composeRequest(ISSUE, "gh", ORIGIN, { ...BASE, search: v })), "composed", `query ${JSON.stringify(v)}`);
  }
});

test("non-ASCII only in a text value, encoded once; a lone surrogate is refused; at most 256 UTF-8 bytes", () => {
  assert.equal(reason(() => composeRequest(ISSUE, "gh", ORIGIN, { ...BASE, owner: "\u00f6" })), "non_ascii");
  assert.equal(reason(() => composeRequest(ISSUE, "gh", ORIGIN, { ...BASE, owner: "a b" })), "argument_type", "an id has no space");
  assert.equal(composeRequest(NAMED, "gh", ORIGIN, { name: "caf\u00e9" }).url, `${ORIGIN}/labels/caf%C3%A9`);
  assert.equal(composeRequest(NAMED, "gh", ORIGIN, { name: "cafe\u0301" }).url, `${ORIGIN}/labels/cafe%CC%81`, "no normalisation");
  for (const v of ["\ud800", "a\udc00", "\udbff\ud800"]) assert.equal(reason(() => composeRequest(NAMED, "gh", ORIGIN, { name: v })), "argument_refused", JSON.stringify(v));
  assert.equal(reason(() => composeRequest(NAMED, "gh", ORIGIN, { name: "\ud83d\ude00" })), "composed", "a surrogate pair is a character");
  assert.equal(MAX_VALUE_BYTES, 256);
  assert.equal(reason(() => composeRequest(NAMED, "gh", ORIGIN, { name: "\u00e9".repeat(128) })), "composed", "256 bytes");
  assert.equal(reason(() => composeRequest(NAMED, "gh", ORIGIN, { name: `${"\u00e9".repeat(128)}a` })), "argument_too_long", "257 bytes");
  assert.equal(reason(() => composeRequest(NAMED, "gh", ORIGIN, { name: "a".repeat(257) })), "argument_too_long");
});

test("types: int range and safety, enum membership, id pattern; the argument set is exactly the template's", () => {
  const cases: ReadonlyArray<readonly [Record<string, unknown>, string]> = [
    [{ ...BASE, number: 0 }, "argument_type"], [{ ...BASE, number: 1.5 }, "argument_type"], [{ ...BASE, number: "42" }, "argument_type"],
    [{ ...BASE, number: 2 ** 53 }, "argument_type"], [{ ...BASE, perPage: 101 }, "argument_type"], [{ ...BASE, state: "all" }, "argument_type"],
    [{ ...BASE, state: "OPEN" }, "argument_type"], [{ ...BASE, owner: 7 }, "argument_type"], [{ ...BASE, search: true }, "argument_type"],
    [{ owner: "o", repo: "r" }, "argument_missing"], [{ ...BASE, extra: "x" }, "argument_unknown"], [{ ...BASE, __proto__: { x: 1 } }, "composed"],
  ];
  for (const [args, want] of cases) assert.equal(reason(() => composeRequest(ISSUE, "gh", ORIGIN, args as never)), want, JSON.stringify(args));
  // Only the caller's OWN properties are arguments: an inherited `state` is not taken.
  const inherited = Object.assign(Object.create({ state: "closed" }), BASE);
  assert.equal(composeRequest(ISSUE, "gh", ORIGIN, inherited).url, `${ORIGIN}/repos/octo/hello.world/issues/42`);
  const custom: OperationTemplate = { method: "GET", path: [{ arg: "sha", type: { kind: "id", pattern: /^[0-9a-f]{40}$/ } }] };
  assert.equal(reason(() => composeRequest(custom, "gh", ORIGIN, { sha: "a".repeat(40) })), "composed");
  assert.equal(reason(() => composeRequest(custom, "gh", ORIGIN, { sha: "A".repeat(40) })), "argument_type");
});

test("a body is built from typed fields only, and a read has none", () => {
  const create: OperationTemplate = { method: "POST", path: [{ literal: "issues" }], body: [{ name: "title", arg: "title", kind: "text", required: true }, { name: "draft", arg: "draft", kind: "bool", required: false }] };
  const c = composeRequest(create, "gh", ORIGIN, { title: "a\nb", draft: true });
  assert.deepEqual(JSON.parse(new TextDecoder().decode(c.body)), { title: "a\nb", draft: true }, "a body text may hold a newline");
  assert.equal(reason(() => composeRequest(create, "gh", ORIGIN, { title: 1 })), "argument_type");
  assert.equal(reason(() => composeRequest(create, "gh", ORIGIN, {})), "argument_missing");
  assert.equal(templateProblem({ ...create, method: "GET" }), "body on a read");
});

test("a bad template or origin composes nothing", () => {
  const t = (over: Partial<OperationTemplate>): OperationTemplate => ({ ...ISSUE, ...over });
  const bad: OperationTemplate[] = [
    t({ method: "TRACE" as never }), t({ method: "PUT" as never }), t({ method: "DELETE" as never }), t({ path: [] }), t({ path: [{ literal: ".." }] }), t({ path: [{ literal: "." }] }), t({ path: [{ literal: "a/b" }] }),
    t({ path: [{ literal: "a%2e" }] }), t({ path: [{ literal: "" }] }), t({ path: [{ arg: "a", type: { kind: "text" } }, { arg: "a", type: { kind: "text" } }] }),
    t({ path: [{ arg: "a", type: { kind: "enum", values: ["x/y"] } }] }), t({ path: [{ arg: "a", type: { kind: "enum", values: [] } }] }),
    t({ path: [{ arg: "a", type: { kind: "id", pattern: /[a-z]+/ } }] }), t({ path: [{ arg: "a", type: { kind: "id", pattern: /^[a-z]+$/g } }] }),
    t({ path: [{ arg: "a", type: { kind: "int", min: 0.5 } }] }), t({ path: [{ arg: "a", type: { kind: "float" } as never }] }), t({ path: [{ arg: "Bad", type: { kind: "text" } }] }),
    t({ query: [{ key: "a&b", arg: "x", type: { kind: "text" }, required: false }] }), t({ query: [{ key: "k", arg: "x", type: { kind: "text" }, required: false }, { key: "k", arg: "y", type: { kind: "text" }, required: false }] }),
    t({ query: [{ key: "k", arg: "owner", type: { kind: "text" }, required: false }] }), t({ path: Array.from({ length: 33 }, () => ({ literal: "a" })) }),
  ];
  for (const b of bad) assert.equal(reason(() => composeRequest(b, "gh", ORIGIN, BASE)), "template_invalid", JSON.stringify(b, (_k, v) => (v instanceof RegExp ? String(v) : v)).slice(0, 120));
  for (const o of ["http://api.example.com", "https://api.example.com:8443", "https://API.example.com", "https://127.0.0.1", "https://api.example.com/", "https://u@api.example.com"]) {
    assert.equal(reason(() => composeRequest(ISSUE, "gh", o, BASE)), "origin_refused", o);
  }
});

test("the composed path is re-checked by the contract's own table: too long is path_refused", () => {
  const long: OperationTemplate = { method: "GET", path: [{ literal: "x" }], query: ["a", "b", "c", "d"].map((k) => ({ key: k, arg: k, type: { kind: "text" as const }, required: true })) };
  const v = "\u00e9".repeat(128); // 256 bytes, 768 encoded characters
  assert.equal(reason(() => composeRequest(long, "gh", ORIGIN, { a: v, b: v, c: "x", d: "x" })), "composed");
  assert.equal(reason(() => composeRequest(long, "gh", ORIGIN, { a: v, b: v, c: v, d: "x" })), "path_refused");
});

test("the integration is recorded on the composed request, and checked", () => {
  assert.equal(composeRequest(NAMED, "gh", ORIGIN, { name: "x" }).integration, "gh");
  assert.equal(composeRequest(NAMED, "gl", ORIGIN, { name: "x" }).integration, "gl");
  assert.equal(composeNetRequest("plugin:p", ORIGIN, "/v1", { kind: "read", method: "GET" }).integration, "plugin:p");
  for (const bad of ["", "GH", "1x", "a b", 7 as never]) assert.equal(reason(() => composeRequest(NAMED, bad, ORIGIN, { name: "x" })), "integration_refused", String(bad));
});

test("errors are closed: the reason only, never an argument or the origin", () => {
  assert.deepEqual([...COMPOSE_REFUSALS].sort(), ["argument_missing", "argument_refused", "argument_too_long", "argument_type", "argument_unknown", "body_refused", "integration_refused", "method_refused", "non_ascii", "origin_refused", "path_refused", "template_invalid"]);
  try {
    composeRequest(NAMED, "gh", "https://canary-origin.example", { name: "CANARY/x" });
  } catch (e) {
    const text = `${(e as Error).message} ${String((e as Error).stack)} ${JSON.stringify(e)}`;
    assert.ok(!text.includes("CANARY") && !text.includes("canary-origin"), text);
  }
});
