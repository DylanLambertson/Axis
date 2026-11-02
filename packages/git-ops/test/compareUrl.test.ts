// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { GitOpsError, compareUrl } from "../src/index.js";

const ok = (remoteUrl: string, extra: { allowedHosts?: string[] } = {}) => compareUrl({ remoteUrl, base: "main", head: "axis/feat", ...extra });

test("https, ssh and scp forms produce the same compare URL", () => {
  const want = "https://github.com/o/r/compare/main...axis/feat";
  for (const u of ["https://github.com/o/r.git", "https://github.com/o/r", "https://GitHub.com/o/r.git", "https://github.com:443/o/r", "ssh://git@github.com/o/r.git", "ssh://git@github.com:22/o/r", "git@github.com:o/r.git", "git@github.com:o/r"]) {
    assert.equal(ok(u), want, u);
  }
});

test("GitHub Enterprise hosts only when configured", () => {
  assert.throws(() => ok("https://ghe.example.com/o/r"), GitOpsError);
  assert.equal(ok("https://ghe.example.com/o/r", { allowedHosts: ["GHE.example.com"] }), "https://ghe.example.com/o/r/compare/main...axis/feat");
  assert.throws(() => ok("https://github.com/o/r", { allowedHosts: ["bad host"] }), GitOpsError);
});

test("userinfo, passwords, odd ports, queries and other schemes are refused", () => {
  for (const u of [
    "https://user:pass@github.com/o/r", "https://user@github.com/o/r", "https://:pw@github.com/o/r",
    "https://github.com:8443/o/r", "https://github.com:80/o/r", "ssh://git@github.com:2222/o/r", "ssh://root@github.com/o/r", "ssh://github.com/o/r",
    "http://github.com/o/r", "git://github.com/o/r", "file:///tmp/r", "ext::sh -c x", "ftp://github.com/o/r",
    "https://github.com/o/r?x=1", "https://github.com/o/r#f", "root@github.com:o/r", "foo@github.com:o/r",
  ]) assert.throws(() => ok(u), GitOpsError, u);
});

test("look-alike, IDN, punycode and malformed hosts are refused", () => {
  for (const u of [
    "https://github.com.evil.example/o/r", "https://evil.example/github.com/o/r", "https://github.com@evil.example/o/r",
    "https://gíthub.com/o/r", "https://xn--gthub-vua.com/o/r", "https://github.com./o/r", "https://github.com%2eevil.example/o/r",
    "https://github.com\\@evil.example/o/r", "https://[::1]/o/r", "https://127.0.0.1/o/r", "https://github/o/r", "git@github.com.evil.example:o/r",
    "https://github.com/o/r\n", "https://github.com/ o/r", "https://github.com/o",
  ]) assert.throws(() => ok(u), GitOpsError, JSON.stringify(u));
});

test("owner and repo are validated and extra path segments refused", () => {
  for (const u of ["https://github.com/o/r/extra", "https://github.com/../r", "https://github.com/o/..", "https://github.com/-o/r", "https://github.com//r", "https://github.com/o/r%2fx", "https://github.com/o/r.git/x"]) {
    assert.throws(() => ok(u), GitOpsError, u);
  }
});

test("ref names are validated and each segment is encoded", () => {
  const u = (base: string, head: string) => compareUrl({ remoteUrl: "https://github.com/o/r", base, head });
  assert.equal(u("release/1.0", "axis/my-feat"), "https://github.com/o/r/compare/release/1.0...axis/my-feat");
  assert.equal(u("a#b", "axis/c%d"), "https://github.com/o/r/compare/a%23b...axis/c%25d");
  for (const bad of ["-x", "a..b", "a b", "", "a\nb", "a:b", "@{u}", "a?b"]) {
    assert.throws(() => u(bad, "axis/x"), GitOpsError, bad);
    assert.throws(() => u("main", bad), GitOpsError, bad);
  }
});

test("a non-string URL is refused", () => {
  assert.throws(() => compareUrl({ remoteUrl: undefined as unknown as string, base: "a", head: "b" }));
});
