// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { acceptValue, checkUpgrade, digestToken, type UpgradeRequest } from "../src/web/handshake.js";

const TOKEN = "A".repeat(42) + "w";
const ctx = { host: "127.0.0.1" as const, port: 40_000, allowedOrigins: new Set(["http://127.0.0.1:5173"]), tokenDigest: digestToken(TOKEN) };
const base: Record<string, string[]> = {
  host: ["127.0.0.1:40000"],
  upgrade: ["websocket"],
  connection: ["keep-alive, Upgrade"],
  "sec-websocket-version": ["13"],
  "sec-websocket-key": ["dGhlIHNhbXBsZSBub25jZQ=="],
  origin: ["http://127.0.0.1:5173"],
  "sec-websocket-protocol": [`axis.v1, axis.auth.${TOKEN}`],
};
const req = (headers: Record<string, string[] | undefined> = {}, line: Partial<UpgradeRequest> = {}): UpgradeRequest => ({ method: "GET", url: "/axis/1", httpVersion: "1.1", headersDistinct: { ...base, ...headers }, ...line });
const reason = (r: UpgradeRequest): string => {
  const c = checkUpgrade(r, ctx);
  return c.ok ? "ok" : `${c.status} ${c.reason}`;
};

test("handshake: a correct request is accepted with the RFC 6455 accept value", () => {
  const c = checkUpgrade(req(), ctx);
  assert.deepEqual(c, { ok: true, accept: "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=" });
  assert.equal(acceptValue("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
  assert.equal(reason(req({ host: ["localhost:40000"] })), "ok");
  assert.equal(reason(req({ "sec-websocket-protocol": ["axis.v1", `axis.auth.${TOKEN}`] })), "ok", "two header lines");
});

test("handshake: the request line must be GET /axis/1 over HTTP/1.1 with no query", () => {
  assert.equal(reason(req({}, { method: "POST" })), "400 bad_method");
  for (const url of ["/", "/axis/1/", "/axis/1?t=x", `/axis/1?token=${TOKEN}`, "/axis/2", "//axis/1"]) assert.equal(reason(req({}, { url })), "404 bad_path", url);
  assert.equal(reason(req({}, { httpVersion: "1.0" })), "400 bad_version");
});

test("handshake: upgrade, connection, version and key are checked", () => {
  assert.equal(reason(req({ upgrade: ["h2c"] })), "426 bad_upgrade");
  assert.equal(reason(req({ upgrade: undefined })), "426 bad_upgrade");
  assert.equal(reason(req({ connection: ["keep-alive"] })), "426 bad_upgrade");
  assert.equal(reason(req({ "sec-websocket-version": ["8"] })), "426 bad_version");
  assert.equal(reason(req({ "sec-websocket-version": ["13", "13"] })), "426 bad_version");
  for (const k of ["short", "dGhlIHNhbXBsZSBub25jZQ", "dGhlIHNhbXBsZSBub25jZQ==x", "dGhlIHNhbXBsZSBub25jZSE="]) assert.equal(reason(req({ "sec-websocket-key": [k] })), "400 bad_key", k);
});

test("handshake: DNS rebinding is refused by the Host check (exactly one value, bound literal or localhost, bound port)", () => {
  for (const host of ["evil.example:40000", "127.0.0.1:40001", "127.0.0.1", "[::1]:40000", "localhost.evil.example:40000", "127.0.0.1:40000 ", "0.0.0.0:40000"]) {
    assert.equal(reason(req({ host: [host] })), "403 bad_host", host);
  }
  assert.equal(reason(req({ host: ["127.0.0.1:40000", "evil.example:40000"] })), "403 bad_host");
  assert.equal(checkUpgrade(req({ host: ["[::1]:40000"] }), { ...ctx, host: "::1" }).ok, true);
  assert.equal(checkUpgrade(req({ host: ["127.0.0.1:40000"] }), { ...ctx, host: "::1" }).ok, false);
});

test("handshake: a cross-site page is refused by the exact Origin check, and a missing or duplicated Origin too", () => {
  for (const origin of ["http://evil.example", "http://127.0.0.1:5174", "https://127.0.0.1:5173", "null", "http://127.0.0.1:5173/", ""]) assert.equal(reason(req({ origin: [origin] })), "403 bad_origin", origin);
  assert.equal(reason(req({ origin: undefined })), "403 bad_origin");
  assert.equal(reason(req({ origin: ["http://127.0.0.1:5173", "http://127.0.0.1:5173"] })), "403 bad_origin");
});

test("handshake: exactly axis.v1 plus one well-formed auth entry; the token must match", () => {
  for (const p of [undefined, ["axis.v1"], [`axis.auth.${TOKEN}`], [`axis.v1, axis.auth.${TOKEN}, chat`], [`axis.v1, axis.auth.${TOKEN}, axis.auth.${TOKEN}`], ["axis.v1, axis.auth.short"]]) {
    assert.equal(reason(req({ "sec-websocket-protocol": p })), "403 bad_protocol", String(p));
  }
  const wrong = `B${TOKEN.slice(1)}`;
  assert.equal(reason(req({ "sec-websocket-protocol": [`axis.v1, axis.auth.${wrong}`] })), "403 bad_token");
});
