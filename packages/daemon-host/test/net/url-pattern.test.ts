// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { inspect } from "node:util";
import { serialize } from "node:v8";
import { composeRequest, type ComposedRequest } from "../../src/net/compose-request.js";
import { declaredOrigins, egressTarget, type EgressTarget } from "../../src/net/host.js";
import * as urlPattern from "../../src/net/url-pattern.js";
import { authorize, Credential, CredentialError, isMatchedTarget, matchTarget, type MatchedTarget, takeAuthorization } from "../../src/net/url-pattern.js";
import { ISSUE, NAMED } from "./templates.js";

// PV-N1e: the final URL check runs on the PARSED target and compares encoded forms exactly; a match snapshots what is sent;
// the credential, bound to one integration and origin, is attached only to an unspent MatchedTarget of that binding.

const ORIGIN = "https://api.example.com";
const DECLARED = declaredOrigins([ORIGIN, "https://other.example.com"]);
const BASE = { owner: "octo", repo: "r", number: 7, state: "open", perPage: 5 };
const SECRET = "Bearer CANARY-0123456789";

const parsed = (url: string): EgressTarget => {
  const t = egressTarget(url, DECLARED);
  assert.ok(typeof t === "object", `${url}: ${String(t)}`);
  return t;
};
const composed = (): ComposedRequest => composeRequest(ISSUE, "gh", ORIGIN, BASE);
const credential = (integration = "gh", origin = ORIGIN): Credential => new Credential(SECRET, { integration, origin });
const isCode = (reason: string) => (e: unknown): boolean => e instanceof CredentialError && e.reason === reason && !e.message.includes("CANARY");

test("the composed URL, parsed, matches itself: compose -> parse is the identity", () => {
  const c = composed();
  const m = matchTarget(c, parsed(c.url));
  assert.ok(isMatchedTarget(m));
  assert.deepEqual([m.origin, m.href], [ORIGIN, c.url], "the brand shows the matched origin and URL, copied");
});

test("every difference in the parsed target is a mismatch, with its own reason", () => {
  const c = composed();
  const url = c.url; // https://api.example.com/repos/octo/r/issues/7?state=open&per_page=5
  const cases: ReadonlyArray<readonly [string, string]> = [
    [url.replace(ORIGIN, "https://other.example.com"), "origin"],
    [`${url}#`, "fragment"], [`${url}#x`, "fragment"],
    [url.replace("/issues/7", "/issues/7/"), "path"], [url.replace("/issues/7", "/issues/8"), "path"], [url.replace("/octo/", "/Octo/"), "path"],
    [url.replace("/repos/", "/repos/x/"), "path"], [url.replace("/issues/7", "/issues/%37"), "path"],
    [url.replace("?state=open&per_page=5", "?per_page=5&state=open"), "query"], [url.replace("&per_page=5", ""), "query"],
    [`${url}&state=open`, "query"], [`${url}&x=1`, "query"], [url.replace("state=open", "state=closed"), "query"],
    [url.replace("state=open", "state"), "query"], [url.replace("state=open", "state=open=x"), "query"], [url.replace("state=open", "=open"), "query"],
    [`${url}&`, "query"], [url.replace("?state=open&per_page=5", ""), "query"], [url.replace("state=", "State="), "query"],
  ];
  for (const [u, why] of cases) assert.equal(matchTarget(c, parsed(u)), why, u);
  const noQuery = composeRequest(ISSUE, "gh", ORIGIN, { owner: "octo", repo: "r", number: 7 });
  assert.equal(matchTarget(noQuery, parsed(`${noQuery.url}?`)), "query", "an empty query is still a query");
  assert.equal(matchTarget(noQuery, parsed(`${noQuery.url}?a=1`)), "query");
});

test("percent-case and encoding differences are mismatches: the encoded forms are compared exactly", () => {
  const url = composeRequest(NAMED, "gh", ORIGIN, { name: "caf\u00e9" }).url; // .../labels/caf%C3%A9
  assert.ok(isMatchedTarget(matchTarget(composeRequest(NAMED, "gh", ORIGIN, { name: "caf\u00e9" }), parsed(url))));
  assert.equal(matchTarget(composeRequest(NAMED, "gh", ORIGIN, { name: "caf\u00e9" }), parsed(url.replace("%C3%A9", "%c3%a9"))), "path", "lower-case hex");
  assert.ok(isMatchedTarget(matchTarget(composeRequest(NAMED, "gh", ORIGIN, { name: "caf\u00e9" }), parsed(url.replace("%C3%A9", "\u00e9")))), "the parser encodes a raw \u00e9 as %C3%A9, the composer's spelling: the bytes sent are the same");
  const q = composeRequest(ISSUE, "gh", ORIGIN, { owner: "o", repo: "r", number: 1, search: "a b" });
  assert.equal(matchTarget(q, parsed(q.url.replace("a%20b", "a+b"))), "query", "+ is not %20");
  assert.equal(matchTarget(q, parsed(q.url.replace("a%20b", "a%2520b"))), "query", "double encoding");
});

test("the match reads the parsed URL: what the parser strips is not seen, what it changes is refused", () => {
  const c = composed();
  // Tabs and newlines are stripped by the WHATWG parser, so the parsed target is the composed one: that is what is sent.
  assert.ok(isMatchedTarget(matchTarget(c, parsed(c.url.replace("/issues/", "/iss\tues/")))));
  const d = composed();
  // A forged composed request whose URL the parser would change (a backslash) can never match the parsed target.
  assert.notEqual(typeof matchTarget({ ...d, url: d.url.replace("/issues/", "/issues\\") } as ComposedRequest, parsed(d.url)), "object");
  // The identity check: segments and query equal, href not.
  assert.equal(matchTarget({ ...d, url: `${d.url}x` } as ComposedRequest, parsed(d.url)), "identity");
});

test("the matcher's own checks hold for a request built by hand, not only for one the composer built", () => {
  // Each forged request has the target's exact href, so only the specific check can refuse it.
  const at = (url: string) => parsed(url);
  const forge = (url: string, segments: string[], query: Array<[string, string]>, kind: "operation" | "net" = "operation"): ComposedRequest =>
    ({ kind, integration: "gh", method: "GET", origin: ORIGIN, url, segments, query, body: undefined }) as ComposedRequest;
  const lower = `${ORIGIN}/labels/caf%c3%a9`;
  assert.equal(matchTarget(forge(lower, ["labels", "caf%c3%a9"], []), at(lower)), "path", "lower-case hex is not the one spelling");
  const short = `${ORIGIN}/a`;
  assert.equal(matchTarget(forge(short, ["a", "b"], []), at(short)), "path", "a missing segment");
  const dup = `${ORIGIN}/a?k=1&k=1`;
  assert.equal(matchTarget(forge(dup, ["a"], [["k", "1"], ["k", "1"]]), at(dup)), "query", "a key twice");
  const net = `${ORIGIN}/b`;
  assert.equal(matchTarget(forge(net, ["a"], [], "net"), at(net)), "path", "an axis.net path other than the composed one");
  const netQuery = `${ORIGIN}/a?y=1`;
  assert.equal(matchTarget(forge(netQuery, ["a"], [["", "x=1"]], "net"), at(netQuery)), "query", "an axis.net query other than the composed one");
});

test("a malformed target or composed request is a closed refusal, never a TypeError (review 1 nit d)", () => {
  const c = composed();
  for (const bad of [new URL(c.url), c.url, null, {}, { url: c.url, origin: ORIGIN }, { url: new URL(c.url) }]) assert.equal(matchTarget(c, bad as never), "target", String(bad));
  for (const bad of [null, "x", { ...c, segments: "a" }, { ...c, integration: 7 }]) assert.equal(matchTarget(bad as never, parsed(c.url)), "target", JSON.stringify(bad));
  for (const body of [new Proxy(new Uint8Array(2), {}), [1, 2], "ab", new DataView(new ArrayBuffer(2))]) assert.equal(matchTarget({ ...c, body } as never, parsed(c.url)), "target", "a body that is not bytes");
});

test("a hand-built target with userinfo is refused, though egressTarget never returns one", () => {
  const c = composed();
  const url = new URL(c.url.replace("https://", "https://u:p@"));
  assert.equal(matchTarget(c, { url, origin: ORIGIN, host: "api.example.com", port: 443 } as EgressTarget), "userinfo");
  const passwordOnly = new URL(c.url.replace("https://", "https://:p@"));
  assert.equal(passwordOnly.username, "");
  assert.equal(matchTarget(composed(), { url: passwordOnly, origin: ORIGIN, host: "api.example.com", port: 443 } as EgressTarget), "userinfo", "a password with no user name (N1e review 3 nit 2)");
});

test("a URL subclass that lies through its getters cannot match or carry the credential elsewhere (review 2 SF2)", () => {
  const evil = "https://evil.example.net/x";
  const forged = () => ({ kind: "operation", integration: "gh", method: "GET", origin: ORIGIN, url: evil, segments: ["x"], query: [], body: undefined }) as unknown as ComposedRequest;
  class LyingOrigin extends URL {}
  Object.defineProperty(LyingOrigin.prototype, "origin", { get: () => ORIGIN });
  class LyingHref extends URL {}
  Object.defineProperty(LyingHref.prototype, "origin", { get: () => ORIGIN });
  Object.defineProperty(LyingHref.prototype, "href", { get: () => `${ORIGIN}/x` });
  assert.equal(matchTarget(forged(), { url: new LyingOrigin(evil), origin: ORIGIN } as EgressTarget), "origin");
  const honest = { ...forged(), url: `${ORIGIN}/x` } as ComposedRequest;
  assert.equal(matchTarget(honest, { url: new LyingHref(evil), origin: ORIGIN } as EgressTarget), "origin", "the record is read, not the getters");
  assert.equal(matchTarget(forged(), { url: new Proxy(new URL(evil), {}), origin: ORIGIN } as EgressTarget), "target", "a Proxy is no URL record");
  // The plain case still matches and attaches.
  const c = composed();
  assert.equal(takeAuthorization(authorize(matchTarget(c, parsed(c.url)) as MatchedTarget, credential())).authorization, SECRET);
});

test("only https matches, and a credential's origin is compared exactly, never as a prefix", () => {
  const http = "http://api.example.com/x";
  const forgedHttp = { kind: "operation", integration: "gh", method: "GET", origin: "http://api.example.com", url: http, segments: ["x"], query: [], body: undefined } as unknown as ComposedRequest;
  assert.equal(matchTarget(forgedHttp, { url: new URL(http), origin: "http://api.example.com" } as EgressTarget), "origin", "an http request built by hand");
  const c = composed();
  const m = matchTarget(c, parsed(c.url)) as MatchedTarget;
  assert.throws(() => authorize(m, credential("gh", "https://api.example.co")), isCode("credential_mismatch"), "a prefix of the matched origin");
  assert.throws(() => new Credential(SECRET, { integration: "gh", origin: "https://API.example.com" }), isCode("credential_invalid"), "the origin schema, not a prefix check");
  assert.throws(() => new Credential(SECRET, { integration: "gh", origin: "https://api.example.com/" }), isCode("credential_invalid"));
});

test("a body detached before the match is a closed refusal, not a throw (N1f nits review D)", () => {
  const body = new Uint8Array([1, 2]);
  const c = { ...composeRequest(NAMED, "gh", ORIGIN, { name: "x" }), method: "POST", body } as ComposedRequest;
  (body.buffer as unknown as { transfer(): ArrayBuffer }).transfer(); // Node 24 has it; the lib target predates it
  assert.equal(body.byteLength, 0, "detached");
  assert.equal(matchTarget(c, parsed(c.url)), "target");
  // A typed array that is not bytes is refused too: copied as bytes it would be truncated (N1f follow-up review E).
  for (const other of [new Uint16Array([1, 2]), new Float64Array([1.5]), new Int8Array([1])]) {
    const d = { ...composeRequest(NAMED, "gh", ORIGIN, { name: "y" }), method: "POST", body: other } as unknown as ComposedRequest;
    assert.equal(matchTarget(d, parsed(d.url)), "target", other.constructor.name);
  }
});

test("a composed request is matched once (review 1 nit a)", () => {
  const c = composed();
  assert.ok(isMatchedTarget(matchTarget(c, parsed(c.url))));
  assert.equal(matchTarget(c, parsed(c.url)), "already_matched");
});

test("what is sent is the match-time snapshot: changing the target or the composed request afterwards changes nothing (review 1 SF1)", () => {
  const c = composed();
  const t = parsed(c.url);
  const m = matchTarget(c, t) as MatchedTarget;
  t.url.href = "https://evil.example.net/steal";
  (t as { origin: string }).origin = "https://evil.example.net";
  const req = authorize(m, credential());
  assert.deepEqual([req.url, req.origin, req.integration, req.method], [c.url, ORIGIN, "gh", "GET"]);
  // A hand-built composed request mutated after the match: the snapshot holds the matched values, the body included.
  const body = new Uint8Array([1, 2, 3]);
  const forged = { ...composeRequest(NAMED, "gh", ORIGIN, { name: "x" }), method: "POST", body } as { -readonly [K in keyof ComposedRequest]: ComposedRequest[K] };
  const fm = matchTarget(forged, parsed(forged.url)) as MatchedTarget;
  forged.url = "https://evil.example.net/";
  forged.integration = "other";
  body.fill(9);
  const freq = authorize(fm, credential());
  assert.deepEqual([freq.url, freq.integration, [...(freq.body ?? [])]], [`${ORIGIN}/labels/x`, "gh", [1, 2, 3]]);
  assert.ok(Object.isFrozen(m) && Object.isFrozen(req));
});

test("a credential is bound to its integration and origin: either one different is credential_mismatch (review 1 SF2)", () => {
  for (const [integration, origin] of [["other", ORIGIN], ["gh", "https://other.example.com"], ["other", "https://other.example.com"]] as const) {
    const c = composed();
    const m = matchTarget(c, parsed(c.url)) as MatchedTarget;
    assert.throws(() => authorize(m, credential(integration, origin)), isCode("credential_mismatch"), `${integration} ${origin}`);
    assert.ok(isMatchedTarget(m), "a refused attach does not spend the match");
    assert.equal(takeAuthorization(authorize(m, credential())).authorization, SECRET, "the right credential still attaches");
  }
  // The other direction: a credential for the other origin attaches only to a request matched on that origin.
  const other = composeRequest(ISSUE, "gh", "https://other.example.com", BASE);
  const om = matchTarget(other, parsed(other.url)) as MatchedTarget;
  assert.throws(() => authorize(om, credential()), isCode("credential_mismatch"));
  assert.equal(takeAuthorization(authorize(om, credential("gh", "https://other.example.com"))).authorization, SECRET);
});

test("the body sent is the one authorized: changing the request's body array after authorize changes nothing (N1f review 1 nit 4)", () => {
  const body = new Uint8Array([1, 2, 3]);
  const c = { ...composeRequest(NAMED, "gh", ORIGIN, { name: "x" }), method: "POST", body } as ComposedRequest;
  const req = authorize(matchTarget(c, parsed(c.url)) as MatchedTarget, credential());
  (req.body as Uint8Array).fill(9);
  body.fill(8);
  assert.deepEqual([...(takeAuthorization(req).body ?? [])], [1, 2, 3], "the taken body is the match-time copy");
});

test("a credential is opaque: every way of printing or serialising it hides the value", () => {
  const cred = credential();
  for (const shown of [String(cred), `${cred}`, JSON.stringify(cred), JSON.stringify({ cred }), inspect(cred), inspect({ cred }, { depth: 5 }), Object.keys(cred).join(), JSON.stringify(Object.entries(cred))]) {
    assert.ok(!shown.includes("CANARY"), shown);
  }
  assert.ok(Object.isFrozen(cred));
  for (const bad of ["", "Bearer a\r\nX: 1", "Bearer \u00e9", "a".repeat(8193), 7 as never]) assert.throws(() => new Credential(bad, { integration: "gh", origin: ORIGIN }), isCode("credential_invalid"));
  for (const binding of [undefined, {}, { integration: "", origin: ORIGIN }, { integration: "gh", origin: "http://x" }, { integration: 7, origin: ORIGIN }]) {
    assert.throws(() => new Credential(SECRET, binding as never), isCode("credential_invalid"), JSON.stringify(binding));
  }
});

test("the credential is attached only to an unspent MatchedTarget, once; the request holds no readable copy of it (review 1 nit c)", () => {
  const c = composed();
  const m = matchTarget(c, parsed(c.url)) as MatchedTarget;
  const req = authorize(m, credential());
  assert.equal("authorizationOf" in urlPattern, false, "no non-spending reader is exported (N1f review 1 nit 1)");
  assert.throws(() => takeAuthorization({ ...req }), isCode("not_authorized"), "a copy carries no credential");
  assert.throws(() => takeAuthorization(structuredClone(req)), isCode("not_authorized"));
  assert.equal(takeAuthorization(req).authorization, SECRET, "the client's one reader, which spends it");
  assert.throws(() => takeAuthorization(req), isCode("not_authorized"), "taken once");
  for (const shown of [JSON.stringify(req), inspect(req, { depth: 5, showHidden: true }), JSON.stringify({ ...req }), inspect(structuredClone(req)), serialize(req).toString("latin1"), Object.getOwnPropertyNames(req).join()]) {
    assert.ok(!shown.includes("CANARY"), shown);
  }
  assert.throws(() => authorize(m, credential()), isCode("not_matched"), "a MatchedTarget is spent once");
  assert.equal(isMatchedTarget(m), false);
  const d = composed();
  const forged = { origin: ORIGIN, href: d.url } as unknown as MatchedTarget;
  assert.throws(() => authorize(forged, credential()), isCode("not_matched"), "a look-alike object is not matched");
  const m2 = matchTarget(d, parsed(d.url)) as MatchedTarget;
  assert.throws(() => authorize({ ...m2 } as MatchedTarget, credential()), isCode("not_matched"), "a copy is not matched");
  assert.throws(() => authorize(Object.create(m2), credential()), isCode("not_matched"), "an object inheriting from it is not matched");
  assert.throws(() => authorize(m2, { toString: () => SECRET } as never), isCode("credential_invalid"));
});
