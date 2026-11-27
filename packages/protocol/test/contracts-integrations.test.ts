// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// axis.integrations/1 and axis.net/1 (PV-N1a): planned, never served; no URL, header, cookie or credential field can be written
// in a request or read in a reply; composed paths, origins, arguments and bodies are refused before anything exists to send.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  reservedKey,
  NET_PATH_REFUSALS,
  netPathRefusal,
  netPathSchema,
  argsSchema,
  netBodySchema,
  resultValueSchema,
  INTEGRATIONS_REASONS,
  INTEGRATIONS_REFUSALS,
  contracts,
  integrationsMethods,
  isIntegrationsRefusal,
  lookupMethod,
  lookupMethodIn,
  netMethods,
  plannedContracts,
  tableProblems,
} from "../src/index.js";
import { INTEGRATIONS_SAMPLES, NET_PATHS_ACCEPTED, NET_PATHS_REFUSED, github } from "./samples-integrations.js";
import { accepts, rejects, runSuite, schemaOf } from "./suite.js";

runSuite(INTEGRATIONS_SAMPLES);

const I = "axis.integrations";
const N = "axis.net";
const base = { projectId: "proj-1", integrationId: "github", operation: "list_pull_requests" };
const net = { projectId: "proj-1", origin: "https://api.example.com", path: "/v1/items", method: "GET" };
const send = { projectId: "proj-1", origin: "https://api.example.com", path: "/v1/items" };

test("both contracts are planned, never served, with the designed method tables", () => {
  for (const key of ["axis.integrations/1", "axis.net/1"]) {
    assert.ok(plannedContracts[key] !== undefined, `${key} is planned`);
    assert.equal(contracts[key], undefined, `${key} is not served`);
  }
  for (const [c, m] of [[I, "read"], [I, "write"], [N, "read"], [N, "send"]] as const) assert.equal(lookupMethod(c, 1, m), undefined, `${c}.${m}`);
  assert.equal(lookupMethodIn(plannedContracts, I, 1, "write"), integrationsMethods.write);
  assert.equal(lookupMethodIn(plannedContracts, I, 1, "request"), undefined, "the one request method is split");
  assert.equal(lookupMethodIn(plannedContracts, N, 1, "request"), undefined, "the one request method is split");
  assert.deepEqual(tableProblems(plannedContracts), []);
  const table = (methods: Record<string, { sideEffect: string; tier: number; idempotency: string }>) =>
    Object.entries(methods).map(([m, s]) => [m, s.sideEffect, s.tier, s.idempotency]);
  assert.deepEqual(table(integrationsMethods), [
    ["list", "read", 0, "none"], ["status", "read", 0, "none"], ["connect", "credential", 4, "none"],
    ["disconnect", "write", 1, "none"], ["read", "read", 0, "none"], ["write", "network", 3, "required"],
  ]);
  assert.deepEqual(table(netMethods), [["read", "read", 0, "none"], ["send", "network", 3, "required"]]);
});

test("no request has a URL, header, cookie, redirect, proxy or credential field, at the root or in an argument", () => {
  const smuggled = ["url", "uri", "href", "headers", "header", "cookie", "authorization", "Authorization", "token", "accessToken", "password", "credential", "apiKey", "redirect", "proxy", "host", "baseUrl", "method"];
  const bodies: Array<[string, string, Record<string, unknown>]> = [
    [I, "list", { projectId: "p" }], [I, "status", { projectId: "p", integrationId: "github" }], [I, "connect", { projectId: "p", integrationId: "github" }],
    [I, "disconnect", { projectId: "p", integrationId: "github" }], [I, "read", base], [I, "write", base], [N, "read", net], [N, "send", send],
  ];
  for (const [contract, method, value] of bodies) {
    const schema = schemaOf(contract, method, "request");
    accepts(schema, value, `${contract}.${method}`);
    for (const key of smuggled) {
      if (key === "method" && contract === N && method === "read") continue; // a real field of axis.net/1.read
      for (const smuggle of ["https://evil.example/", { a: "b" }, ["a"]]) rejects(schema, { ...value, [key]: smuggle }, `${contract}.${method} + ${key}: ${typeof smuggle}`);
    }
  }
  const request = schemaOf(I, "read", "request");
  for (const key of ["url", "uri", "href", "link", "host", "hostname", "origin", "baseUrl", "header", "headers", "cookie", "cookies", "authorization", "auth", "bearer", "token", "accessToken", "refreshToken", "idToken", "secret", "clientSecret", "password", "credential", "credentials", "apiKey", "key", "proxy", "redirect", "method", "path", "query",
    "authToken", "apiToken", "bearerToken", "xApiKey", "privateKey", "sessionId", "setCookie", "proxyUrl", "redirectUri", "callbackUrl", "clientSecret", "jwt",
    // the all-lower-case and upper-case-ending spellings a camelCase split misses
    "accesstoken", "refreshtoken", "idtoken", "clientsecret", "authtoken", "bearertoken", "oauthtoken", "setcookie", "proxyurl", "redirectto", "callbackurl",
    "xapikey", "callbackURL", "webhookURL", "targetURL", "imageURL", "ACCESSTOKEN", "pwd", "privKey", "passphrase", "sessiontoken", "hostName", "originUrl"]) {
    rejects(request, { ...base, args: { [key]: "x" } }, `argument key ${key}`);
    rejects(request, { ...base, args: { [key.toUpperCase()]: "x" } }, `argument key ${key} upper case`);
  }
  for (const ok of ["author", "authors", "authorName", "authorlogin", "sortKey", "filePath", "state", "perPage", "number", "securityLevel", "securityadvisory", "pullNumber", "title", "labels", "milestone", "assignee", "sortDirection"]) accepts(request, { ...base, args: { [ok]: "x" } }, `a real argument ${ok}`);
  rejects(request, { ...base, args: { access_token: "x" } }, "snake case never matches the key pattern");
  rejects(request, { ...base, args: { "access-token": "x" } }, "a dash");
  rejects(request, { ...base, args: { ["x" + "a".repeat(32)]: "x" } }, "a 33-character key");
});

test("reservedKey: a table of spellings, whatever the case, joining or separator", () => {
  const refused = [
    "accessToken", "accesstoken", "ACCESSTOKEN", "access_token", "Access-Token", "refreshToken", "refreshtoken", "idToken", "idtoken", "clientSecret", "clientsecret",
    "authToken", "authtoken", "bearerToken", "oauthToken", "setCookie", "setcookie", "set-cookie", "proxyUrl", "proxyurl", "redirectTo", "redirectto", "redirectUri",
    "callbackUrl", "callbackurl", "callbackURL", "webhookURL", "targetURL", "imageURL", "xApiKey", "xapikey", "x-api-key", "API_KEY", "apiKey", "privateKey", "privKey",
    "pwd", "passwd", "password", "passphrase", "sessionId", "sessiontoken", "Authorization", "authorization", "cookie", "jwt", "hostName", "originUrl", "headers", "href", "uri",
    "key", "KEY", "path", "Query", "method", "link", "callback", "callbackFn", "sessionName", "oauth", "bearer", "redirect", "proxy", "origin", "host", "secret", "token", "credential", "accessKey", "signingKey",
  ];
  const legal = [
    "author", "Author", "authors", "authorName", "authorLogin", "securityLevel", "securitylevel", "securityAdvisory", "sortKey", "sortkey", "filePath", "state", "perPage",
    "number", "title", "labels", "milestone", "assignee", "sortDirection", "pullNumber", "body", "name", "page", "since", "ref", "sha", "draft", "base", "head",
  ];
  assert.ok(refused.length + legal.length >= 80);
  for (const k of refused) assert.equal(reservedKey(k), true, `${k} is refused`);
  for (const k of legal) assert.equal(reservedKey(k), false, `${k} is legal`);
});

test("an argument is a bounded text without NUL, a safe integer or a boolean; nothing nests", () => {
  const request = schemaOf(I, "read", "request");
  for (const value of ["", "x", "line\nbreak", "é".repeat(65_536), 0, -5, Number.MAX_SAFE_INTEGER, true]) accepts(request, { ...base, args: { v: value } }, String(value).slice(0, 20));
  for (const value of ["a\u0000b", "x".repeat(65_537), 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60, null, undefined, [], ["a"], {}, { a: 1 }, () => 1]) {
    rejects(request, { ...base, args: { v: value } }, `argument ${typeof value} ${String(value).slice(0, 12)}`);
  }
  accepts(request, { ...base, args: Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`k${i}`, i])) }, "32 arguments");
  rejects(request, { ...base, args: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, i])) }, "33 arguments");
  rejects(request, { ...base, args: "path=/x" }, "arguments are a record");
  rejects(request, { ...base, args: [["a", 1]] }, "arguments are not pairs");
  rejects(request, { ...base, operation: "List-Pull" }, "an operation id is lower snake case");
  rejects(request, { ...base, operation: "../x" }, "an operation is not a path");
  rejects(request, { ...base, integrationId: "GitHub" }, "an integration id is lower case");
  rejects(request, { ...base, integrationId: "integration:github" }, "the vault entry name is not an id");
});

test("an origin is a punycode https host: no IP literal in any spelling, port, userinfo, trailing dot, bracket or path", () => {
  const request = schemaOf(N, "read", "request");
  for (const origin of ["https://api.example.com", "https://a.b.c.example.co.uk", "https://xn--bcher-kva.example", "https://example.xn--p1ai", "https://a-b.example.com"]) {
    accepts(request, { ...net, origin }, origin);
  }
  for (const origin of [
    "http://api.example.com", "https://127.0.0.1", "https://2130706433", "https://0x7f.1", "https://127.1", "https://[::1]", "https://[::ffff:127.0.0.1]",
    "https://10.0.0.1", "https://169.254.169.254", "https://localhost", "https://example", "https://api.example.com.", "https://api.example.com:8443",
    "https://user@api.example.com", "https://user:pw@api.example.com", "https://api.example.com/", "https://api.example.com/x", "https://api.example.com?x=1",
    "https://api.example.com#x", "https://API.example.com", "https://bücher.example", "https://a_b.example.com", "https://-a.example.com", "https://a-.example.com",
    "https://a..example.com", "https://.example.com", "https://example.123", "https://1.2.3.4.5", "https://a.example.com\n", " https://a.example.com", "//a.example.com", "a.example.com",
    `https://${"a".repeat(64)}.example.com`, `https://${Array.from({ length: 60 }, () => "abcd").join(".")}.com`,
  ]) {
    rejects(request, { ...net, origin }, JSON.stringify(origin));
  }
});

test("a path is composed: no CR, LF, control, space, backslash, fragment, dot segment in any spelling, escaped slash or backslash", () => {
  const request = schemaOf(N, "read", "request");
  for (const path of NET_PATHS_ACCEPTED) accepts(request, { ...net, path }, path.slice(0, 30));
  for (const path of NET_PATHS_REFUSED) rejects(request, { ...net, path }, JSON.stringify(path).slice(0, 40));
});

test("the schema and netPathRefusal agree on the whole table, and every refusal row is reached", () => {
  assert.ok(NET_PATHS_ACCEPTED.length + NET_PATHS_REFUSED.length >= 60);
  for (const p of NET_PATHS_ACCEPTED) assert.equal(netPathRefusal(p), null, p.slice(0, 40));
  for (const p of NET_PATHS_REFUSED) {
    assert.notEqual(netPathRefusal(p), null, JSON.stringify(p).slice(0, 40));
    assert.equal(netPathSchema.safeParse(p).success, false);
  }
  const reached = new Set(NET_PATHS_REFUSED.map(netPathRefusal));
  assert.deepEqual([...NET_PATH_REFUSALS.map(([r]) => r)].filter((r) => !reached.has(r)), [], "a refusal row no spelling reaches");
});

test("axis.net/1.read allows GET and HEAD only; axis.net/1.send is a POST with no method field and a JSON object body", () => {
  const read = schemaOf(N, "read", "request");
  const sendReq = schemaOf(N, "send", "request");
  for (const method of ["GET", "HEAD"]) accepts(read, { ...net, method }, method);
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "CONNECT", "TRACE", "get", "Head", "GET ", "", "GET\r\nX: 1"]) rejects(read, { ...net, method }, JSON.stringify(method));
  rejects(read, { ...net, body: { a: 1 } }, "a read has no body");
  accepts(sendReq, send, "a POST without a body");
  accepts(sendReq, { ...send, body: {} }, "an empty object body");
  for (const method of ["GET", "POST", "PUT"]) rejects(sendReq, { ...send, method }, `a method field (${method}) on send`);
  for (const body of ["text", 1, true, null, ["a"], [], "x=1"]) rejects(sendReq, { ...send, body }, `body ${JSON.stringify(body)}`);
  const deep = (n: number): unknown => (n === 0 ? 1 : { a: deep(n - 1) });
  accepts(sendReq, { ...send, body: deep(6) }, "body at depth 6");
  rejects(sendReq, { ...send, body: deep(7) }, "body at depth 7");
  rejects(sendReq, { ...send, body: { a: "x".repeat(65_537) } }, "an oversized text");
  rejects(sendReq, { ...send, headers: { "Content-Type": "text/plain" } }, "no header can be set, even Content-Type");
});

test("a key __proto__, constructor or prototype is refused in arguments, bodies and results, never silently dropped", () => {
  const parse = (json: string): unknown => JSON.parse(json);
  const withKey = (key: string): string => `{"${key}":{"polluted":1},"a":1}`;
  for (const key of ["__proto__", "constructor", "prototype"]) {
    // The schemas themselves (not only the envelope's walk, which also refuses these keys): an own key from JSON.parse.
    rejects(argsSchema, parse(withKey(key)), `args ${key}`);
    rejects(netBodySchema, parse(withKey(key)), `body ${key}`);
    rejects(resultValueSchema, parse(withKey(key)), `result ${key}`);
    rejects(resultValueSchema, parse(`{"outer":${withKey(key)}}`), `nested result ${key}`);
    rejects(schemaOf(N, "send", "request"), { ...send, body: parse(withKey(key)) }, `send body ${key} through the guard`);
    rejects(schemaOf(I, "read", "request"), { ...base, args: parse(withKey(key)) }, `read args ${key} through the guard`);
  }
  assert.equal(({} as Record<string, unknown>)["polluted"], undefined, "nothing was assigned to the prototype");
});

test("a reply carries a status and one typed value: no header, Location, cookie or credential, and no 3xx or error status", () => {
  const rep = schemaOf(I, "read", "response");
  const netRep = schemaOf(N, "read", "response");
  accepts(rep, { status: 200, result: {} }, "200");
  accepts(netRep, { status: 204, body: null }, "204 with no body");
  for (const status of [100, 199, 300, 301, 302, 307, 308, 400, 404, 500, 200.5, "200", null]) {
    rejects(rep, { status, result: {} }, `status ${String(status)}`);
    rejects(netRep, { status, body: {} }, `net status ${String(status)}`);
  }
  for (const extra of ["headers", "location", "Location", "setCookie", "cookie", "token", "accessToken", "authorization", "url", "contentType"]) {
    rejects(rep, { status: 200, result: {}, [extra]: "x" }, `reply + ${extra}`);
    rejects(netRep, { status: 200, body: {}, [extra]: "x" }, `net reply + ${extra}`);
  }
  const deep = (n: number): unknown => (n === 0 ? 1 : { a: deep(n - 1) });
  accepts(rep, { status: 200, result: deep(11) }, "result at its depth");
  rejects(rep, { status: 200, result: deep(13) }, "result past its depth");
  rejects(rep, { status: 200, result: { a: "x".repeat(65_537) } }, "an oversized text");
  rejects(rep, { status: 200, result: Array.from({ length: 1001 }, () => 1) }, "too many items");
  rejects(rep, { status: 200, result: Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`k${i}`, 1])) }, "too many keys");
  rejects(rep, { status: 200, result: { a: Number.POSITIVE_INFINITY } }, "a non-finite number");
});

test("an integration summary shows no credential and no URL beyond its punycode origins; scopes are tokens", () => {
  const list = schemaOf(I, "list", "response");
  const one = (over: Record<string, unknown>) => ({ integrations: [{ ...github, ...over }] });
  accepts(list, one({}), "the vector");
  for (const extra of ["token", "accessToken", "refreshToken", "secret", "url", "headers", "vaultEntry", "clientId"]) rejects(list, one({ [extra]: "x" }), `summary + ${extra}`);
  rejects(list, one({ origins: [] }), "an integration declares an origin");
  rejects(list, one({ origins: ["https://api.github.com/v3"] }), "an origin with a path");
  rejects(list, one({ origins: ["https://bücher.example"] }), "a non-punycode origin");
  rejects(list, one({ origins: Array.from({ length: 9 }, (_, i) => `https://a${i}.example.com`) }), "nine origins");
  rejects(list, one({ grantedScopes: ["repo read"] }), "a scope with a space");
  rejects(list, one({ grantedScopes: ["ghp_" + "x".repeat(70)] }), "a scope as long as a token");
  rejects(list, one({ declaredScopes: Array.from({ length: 33 }, (_, i) => `s${i}`) }), "33 scopes");
  rejects(list, one({ state: "revoked" }), "a closed state");
  rejects(list, one({ label: " GitHub" }), "label edge space");
  rejects(list, one({ label: "Git‮Hub" }), "label bidi control");
  rejects(list, one({ operations: [{ operation: "x", write: "yes" }] }), "write is a boolean");
  rejects(list, one({ operations: [{ operation: "x", write: false, url: "https://x" }] }), "an operation has no URL");
  rejects(list, { integrations: Array.from({ length: 65 }, () => github) }, "65 integrations");
});

test("write and send carry an optional approval (tier 3), as connect does (tier 4); reads and disconnect carry none; no payload says who is calling", () => {
  const challenge = { challengeId: "A".repeat(43) };
  accepts(schemaOf(I, "write", "request"), { ...base, approval: challenge }, "write with approval");
  accepts(schemaOf(N, "send", "request"), { ...send, approval: challenge }, "send with approval");
  rejects(schemaOf(I, "write", "request"), { ...base, approval: { challengeId: "short" } }, "a malformed challenge");
  rejects(schemaOf(I, "read", "request"), { ...base, approval: challenge }, "read takes no approval");
  rejects(schemaOf(N, "read", "request"), { ...net, approval: challenge }, "net read takes no approval");
  rejects(schemaOf(I, "connect", "request"), { projectId: "p", integrationId: "github", approval: { challengeId: "short" } }, "a malformed challenge");
  rejects(schemaOf(I, "disconnect", "request"), { projectId: "p", integrationId: "github", approval: { challengeId: "A".repeat(43) } }, "disconnect takes no approval");
  for (const [c, m] of [[I, "connect"], [I, "disconnect"], [I, "read"], [I, "write"], [N, "read"], [N, "send"]] as const) {
    rejects(schemaOf(c, m, "request"), { ...(c === N ? (m === "read" ? net : send) : base), integrationId: "github", actor: "user", createdBy: "user", principal: "plugin:x" }, `${c}.${m}: no caller field`);
  }
});

test("the refusals are closed and never echo an argument, host, body or Location", () => {
  assert.deepEqual(Object.keys(INTEGRATIONS_REFUSALS), ["E_NOT_FOUND", "E_INVALID_ARGUMENT", "E_CONFLICT", "E_UNAVAILABLE", "E_TIMEOUT"]);
  assert.equal(new Set(INTEGRATIONS_REASONS).size, INTEGRATIONS_REASONS.length);
  for (const reason of INTEGRATIONS_REASONS) assert.match(reason, /^[a-z][a-z_]*$/);
  for (const reason of ["operation_kind_mismatch", "request_too_large", "response_too_large", "redirect_refused", "headers_too_large", "credential_echoed", "audit_unavailable"]) {
    assert.ok(INTEGRATIONS_REASONS.includes(reason as never), reason);
  }
  assert.equal(isIntegrationsRefusal("E_UNAVAILABLE", "redirect_refused"), true);
  assert.equal(isIntegrationsRefusal("E_INVALID_ARGUMENT", "redirect_refused"), false);
  assert.equal(isIntegrationsRefusal("E_POLICY_DENIED", "busy"), false);
  assert.equal(isIntegrationsRefusal("toString", "busy"), false);
});
