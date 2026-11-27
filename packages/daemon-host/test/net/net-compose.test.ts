// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { composeNetRequest, CompositionError } from "../../src/net/compose-request.js";
import { declaredOrigins, egressTarget } from "../../src/net/host.js";
import { isMatchedTarget, matchTarget } from "../../src/net/url-pattern.js";

// PV-N1e: axis.net/1 (ADR 0009 decision 1): a plugin's composed path to a granted origin. The contract's refusal table
// judges the path again here, the method set is GET and HEAD for read and POST for send, and the parsed path and query
// must be exactly the composed text.

const ORIGIN = "https://api.example.com";
const DECLARED = declaredOrigins([ORIGIN]);
const read = (path: string, method = "GET") => composeNetRequest("plugin:x", ORIGIN, path, { kind: "read", method });
const why = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    assert.ok(e instanceof CompositionError, String(e));
    return e.reason;
  }
  return "composed";
};
const match = (path: string): string => {
  const c = read(path);
  const t = egressTarget(c.url, DECLARED);
  if (typeof t === "string") return `target ${t}`;
  const m = matchTarget(c, t);
  return isMatchedTarget(m) ? "matched" : m;
};

test("read takes GET or HEAD, send is a POST with an optional JSON object body", () => {
  assert.equal(read("/v1", "GET").method, "GET");
  assert.equal(read("/v1", "HEAD").method, "HEAD");
  for (const m of ["POST", "PUT", "DELETE", "get", "Head", "GET ", "", "GET\r\nX: 1"]) assert.equal(why(() => read("/v1", m)), "method_refused", JSON.stringify(m));
  const sent = composeNetRequest("plugin:x", ORIGIN, "/v1/items", { kind: "send", body: { a: [1, "x"], b: { c: true } } });
  assert.deepEqual([sent.method, JSON.parse(new TextDecoder().decode(sent.body))], ["POST", { a: [1, "x"], b: { c: true } }]);
  assert.equal(composeNetRequest("plugin:x", ORIGIN, "/v1", { kind: "send" }).body, undefined);
  const deep = (n: number): unknown => (n === 0 ? 1 : { a: deep(n - 1) });
  assert.equal(why(() => composeNetRequest("plugin:x", ORIGIN, "/v1", { kind: "send", body: deep(6) })), "composed");
  for (const body of [deep(7), ["a"], "text", 1, null]) assert.equal(why(() => composeNetRequest("plugin:x", ORIGIN, "/v1", { kind: "send", body })), "body_refused", JSON.stringify(body).slice(0, 30));
});

test("the path is judged by the contract's own table here too, and the origin by its schema", () => {
  for (const bad of ["", "Plugin", 7 as never]) assert.equal(why(() => composeNetRequest(bad, ORIGIN, "/v1", { kind: "read", method: "GET" })), "integration_refused", String(bad));
  for (const p of ["", "v1", "/a//b", "//evil.com/x", "/..", "/x/%2e%2e/y", "/a%2fb", "/a%3bb", "/..;/x", "/a\r\nb", "/a b", "/a?b?c", "/a#b", "/%252e/x", "/%c0%ae"]) {
    assert.equal(why(() => read(p)), "path_refused", JSON.stringify(p));
  }
  for (const o of ["http://api.example.com", "https://127.0.0.1", "https://api.example.com:443", "https://API.example.com"]) assert.equal(why(() => composeNetRequest("plugin:x", o, "/v1", { kind: "read", method: "GET" })), "origin_refused", o);
});

test("an accepted path is matched only when the parser gives it back unchanged", () => {
  for (const p of ["/", "/v1", "/v1/items/", "/v1/items?limit=10&after=a%20b", "/~user/@x", "/a;b/c", "/a:b;c=d", "/x?u=//y", "/a.b/c..d/...", "/%41", "/x?next=%2e%2e"]) {
    assert.equal(match(p), "matched", p);
  }
  // The WHATWG parser percent-encodes a quote in the query of an https URL, so the sent text would differ: refused.
  assert.equal(match("/x?q='"), "query");
  // An empty query (`?` alone) is not kept by the parser: refused rather than sent differently.
  assert.equal(match("/x?"), "query");
  // A dot-like segment the contract allows but the parser would resolve cannot slip through: `%2E` is refused by the table.
  assert.equal(why(() => read("/a/%2E/b")), "path_refused");
});

test("an axis.net path never matches another request's parsed target", () => {
  const c = read("/v1/items?x=1");
  for (const other of ["/v1/items?x=2", "/v1/items", "/v1/items/?x=1", "/v1/Items?x=1", "/v1/items?x=1&y=2"]) {
    const t = egressTarget(`${ORIGIN}${other}`, DECLARED);
    assert.ok(typeof t === "object");
    assert.notEqual(typeof matchTarget(c, t), "object", other);
  }
});
