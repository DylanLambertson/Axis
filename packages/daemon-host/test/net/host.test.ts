// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { declaredOrigins, egressTarget } from "../../src/net/host.js";

// PV-N1d slice A: a request goes only to an HTTPS origin in the declared set, written in exactly one spelling.

const DECLARED = declaredOrigins(["https://api.example.com", "https://xn--bcher-kva.example", "https://port.example.com:8443"]);
const target = (u: string) => egressTarget(u, DECLARED);

test("a declared origin in its one spelling is a target, with the parsed host and port", () => {
  const t = target("https://api.example.com/v1/items?x=1#f");
  assert.ok(typeof t === "object");
  assert.deepEqual([t.host, t.port, t.origin, t.url.pathname], ["api.example.com", 443, "https://api.example.com", "/v1/items"]);
  const p = target("https://port.example.com:8443/x");
  assert.ok(typeof p === "object");
  assert.deepEqual([p.host, p.port, p.origin], ["port.example.com", 8443, "https://port.example.com:8443"]);
  assert.equal(typeof target("https://xn--bcher-kva.example/"), "object", "punycode is the one spelling");
  assert.equal(typeof target("https://api.example.com"), "object", "no path");
});

test("every IP literal spelling is refused", () => {
  for (const u of ["https://127.0.0.1/", "https://2130706433/", "https://0x7f.1/", "https://0177.0.0.1/", "https://127.1/", "https://0x7f000001/",
    "https://[::1]/", "https://[::ffff:127.0.0.1]/", "https://[2606:4700::1111]/", "https://1.1.1.1/", "https://169.254.169.254/latest"]) {
    assert.equal(target(u), "ip_literal", u);
  }
});

test("userinfo, a trailing dot, a non-canonical host or port, a backslash and other schemes are refused", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["https://user@api.example.com/", "userinfo"], ["https://@api.example.com/", "userinfo"], ["https://u:p@api.example.com/", "userinfo"],
    ["https://api.example.com./", "trailing_dot"],
    ["https://API.example.com/", "not_canonical"], ["https://Api.Example.Com/", "not_canonical"], ["https://bücher.example/", "not_canonical"],
    ["https://api%2eexample.com/", "not_canonical"], ["https://api.example.com:443/", "not_canonical"], ["https://port.example.com:08443/", "not_canonical"],
    ["https://api.example.com\\@evil.example/", "malformed"], ["https://api.exa mple.com/", "malformed"], ["https://", "malformed"],
    ["http://api.example.com/", "not_https"], ["HTTPS://api.example.com/", "not_https"], ["ftp://api.example.com/", "not_https"], [" https://api.example.com/", "not_https"],
    ["https:///api.example.com/", "not_canonical"],
  ];
  for (const [u, why] of cases) assert.equal(target(u), why, u);
});

test("an origin outside the declared set is refused: another host, a sub-domain, another port", () => {
  for (const u of ["https://evil.example/", "https://x.api.example.com/", "https://api.example.com.evil.example/", "https://port.example.com/", "https://api.example.com:8443/", "https://port.example.com:9443/"]) {
    assert.equal(target(u), "origin_not_declared", u);
  }
});

test("declared origins are plain HTTPS origins in URL.origin form; anything else matches nothing", () => {
  assert.deepEqual([...declaredOrigins(["https://a.example", "http://b.example", "https://c.example/", "https://u@d.example", "https://E.example", "https://f.example.", "not a url", "https://g.example:443"])], ["https://a.example"]);
});
