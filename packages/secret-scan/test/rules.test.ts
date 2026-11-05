// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { canary, hexOf, patch, randomValue, rnd, rules, scan, assertNoText } from "./helpers.js";

const one = (line: string, path = "src/a.ts") => scan(patch(path, [line]));

test("each fixed-format rule reports its name, the file and the line, and never the text", () => {
  const cases: [string, string, string][] = [
    ["private-key-block", canary.pemHeader("RSA"), ""],
    ["private-key-block", canary.pemHeader("OPENSSH"), ""],
    ["private-key-block", "-----BEGIN PRIVATE" + " KEY-----", ""],
    ["private-key-block", "-----BEGIN PGP PRIVATE" + " KEY BLOCK-----", ""],
    ["aws-access-key-id", `id: ${canary.aws()}`, canary.aws()],
    ["gcp-api-key", `k=${canary.gcp()}`, canary.gcp()],
    ["github-token", `x ${canary.github()} y`, canary.github()],
    ["gitlab-token", canary.gitlab(), canary.gitlab()],
    ["slack-token", canary.slack(), canary.slack()],
    ["stripe-key", `"${canary.stripe()}"`, canary.stripe()],
    ["npm-token", canary.npm(), canary.npm()],
    ["ai-api-key", canary.anthropic(), canary.anthropic()],
    ["jwt", `Authorization: ${canary.jwt()}`, canary.jwt()],
  ];
  for (const [rule, line, text] of cases) {
    const fs = scan(patch("conf/x.txt", ["// first", line]));
    assert.deepEqual(fs, [{ rule, path: "conf/x.txt", line: 2 }], rule);
    assertNoText(fs, ...(text ? [text] : []));
  }
});

test("connection strings and URLs with a password or a token", () => {
  const pw = randomValue(5, 20);
  for (const scheme of ["postgres", "postgresql", "mysql", "mongodb+srv", "redis", "amqps"]) {
    const fs = one(`DATABASE_URL=${scheme}://app:${pw}@db.internal:5432/main`);
    assert.ok(rules(fs).includes("connection-string-password"), scheme);
    assertNoText(fs, pw);
  }
  assert.deepEqual(rules(one(`origin = https://deploy:${pw}@git.example.org/team/repo.git`)), ["url-credentials"]);
  assert.deepEqual(rules(one(`remote = https://${randomValue(6, 40)}@git.example.org/team/repo.git`)), ["url-embedded-token"]);
  assert.ok(rules(one(`Server=db1.internal;Database=main;User Id=app;Password=${pw};`)).includes("connection-string-password"));
  assert.deepEqual(rules(one(`DefaultEndpointsProtocol=https;AccountName=a;AccountKey=${rnd(9, 86, "ABCDEFabcdef0123456789+/")}==`)), ["azure-shared-key"]);
});

test("bearer and basic credentials", () => {
  const t = randomValue(7, 40);
  assert.deepEqual(rules(one(`curl -H "Authorization: Bearer ${t}" https://api.internal/x`)), ["bearer-token"]);
  assert.deepEqual(rules(one("Authorization: bearer\t" + t)), ["bearer-token"]);
  const basic = Buffer.from(`svc-${rnd(3, 6)}:${randomValue(8, 18)}`).toString("base64");
  assert.deepEqual(rules(one(`Authorization: Basic ${basic}`)), ["basic-auth-header"]);
});

test("generic assignments next to a credential name, in several syntaxes and cases", () => {
  const v = randomValue(11, 36);
  const lines = [
    `${canary.name("secret")} = "${v}"`,
    `${canary.name("token").toUpperCase()}: '${v}'`,
    `"${canary.name("password")}": "${v}",`,
    `export ${canary.name("key").toUpperCase()}=${v}`,
    `Client_Secret := "${v}"`,
    `config.apiToken => \`${v}\``,
    `${canary.name("token")}\t=\t${v}`,
    `//registry.example.org/:_authToken=${v}`,
    `?access_token=${v}&x=1`,
  ];
  for (const l of lines) {
    const fs = one(l);
    assert.deepEqual(rules(fs), ["generic-secret-assignment"], l.slice(0, 12));
    assertNoText(fs, v);
  }
});

test("false positives: ids, hashes, words, placeholders and test fixtures stay quiet", () => {
  const uuid = `${hexOf(1, 8)}-${hexOf(2, 4)}-${hexOf(3, 4)}-${hexOf(4, 4)}-${hexOf(5, 12)}`;
  const sha1 = hexOf(6, 40);
  const sha256 = hexOf(7, 64);
  const quiet = [
    `commit ${sha1}`,
    `tokenizer_sha = "${sha1}"`,
    `tokenizer_hash: "${sha256}"`,
    `tokenizerRev = "${sha1}"`,
    `--token-file=/some/very/long/path/to/a/file2`,
    `token=/usr/local/lib/node_modules/some-package-name2`,
    `${canary.name("token")}: "${uuid}"`,
    `sessionToken: "${uuid}"`,
    `${canary.name("password")} = "hunter2"`,
    `${canary.name("password")} = "correct-horse-battery-staple"`,
    `${canary.name("secret")}: "your-api-secret-goes-here-1234"`,
    `${canary.name("token")} = process.env.SOME_LONG_TOKEN_NAME_2`,
    `${canary.name("token")} = "\${DEPLOY_TOKEN_FROM_THE_ENVIRONMENT}"`,
    `${canary.name("secret")} = "<insert-secret-value-here-123>"`,
    `const tokenizer = new TokenizerFactory().create2()`,
    `getAuthenticationTokenFromStorage()`,
    `${canary.name("token")} == someFunctionReturningAToken2(value)`,
    `password: SCREAMING_SNAKE_CASE_NAME_2`,
    `token: "test-token-for-the-unit-tests-2"`,
    `Basic authentication is described in the next section`,
    `Bearer tokens are described in the next section 2`,
    `postgres://user:password@localhost:5432/db`,
    `postgres://postgres:postgres@localhost/db`,
    `https://user:\${PASSWORD}@example.org/`,
    `https://example.org/path/to/file.html#section-2`,
    `-----BEGIN CERTIFICATE-----`,
    `ssh-ed25519 ${rnd(2, 68)} user@host`,
    `AKIA`,
  ];
  for (const l of quiet) assert.deepEqual(one(l), [], l);
});

test("lock files: digests and ids never trip the generic rules; a fixed format still does", () => {
  const integ = `sha512-${rnd(4, 86, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/")}==`;
  const lock = patch("package-lock.json", [`"integrity": "${integ}",`, `"${canary.name("token")}": "${randomValue(3, 40)}"`, `"resolved": "https://registry.example.org/a/-/a-1.0.0.tgz",`]);
  assert.deepEqual(scan(lock), []);
  assert.deepEqual(rules(scan(patch("Cargo.lock", [`id = "${canary.aws()}"`]))), ["aws-access-key-id"]);
});

test("encodings: CRLF, tabs, zero-width characters, full-width letters and case", () => {
  const aws = canary.aws(4);
  const crlf = scan(patch("a.txt", [`x=${aws}`], { eol: "\r" }));
  assert.deepEqual(rules(crlf), ["aws-access-key-id"]);
  const zw = aws.slice(0, 6) + "\u200b" + aws.slice(6, 12) + "\u2060\ufeff" + aws.slice(12);
  assert.deepEqual(rules(one(`x=${zw}`)), ["aws-access-key-id"]);
  const wide = [...aws].map((c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0)).join("");
  assert.deepEqual(rules(one(`x=${wide}`)), ["aws-access-key-id"]);
  const header = canary.pemHeader("EC").replace(" ", "\u200d ").replace("BEGIN", "BE\u00adGIN");
  assert.deepEqual(rules(one(header)), ["private-key-block"]);
  const v = randomValue(2, 30);
  assert.deepEqual(rules(one(`PaSsWoRd\t:\t\t"${v}"`)), ["generic-secret-assignment"]);
  assert.deepEqual(rules(one(`TOKEN="${v}"`)), ["generic-secret-assignment"]);
});

test("encodings: one level of base64 or hex around a fixed format is looked through", () => {
  const b64 = (s: string): string => Buffer.from(s).toString("base64");
  assert.deepEqual(rules(one(`data: ${b64(canary.pemHeader("RSA") + "\nMIIE")}`)), ["base64-private-key-block"]);
  assert.deepEqual(rules(one(`blob=${b64(`id=${canary.aws(2)} `)}`)), ["base64-aws-access-key-id"]);
  assert.deepEqual(rules(one(`blob=${Buffer.from(canary.github(3)).toString("hex")}`)), ["hex-github-token"]);
  assert.deepEqual(rules(one(`blob=${Buffer.from(canary.aws(3)).toString("base64url")}`)), ["base64-aws-access-key-id"]);
  // Two levels, a split token and a value that is only a fragment are out of scope (docs/packages.md).
  assert.deepEqual(one(`blob=${b64(b64(canary.aws(2)))}`), []);
  assert.deepEqual(one(`x="${canary.aws(2).slice(0, 10)}" + "${canary.aws(2).slice(10)}"`), []);
  assert.deepEqual(one(`blob=${hexOf(8, 64)}`), []);
});

test("sensitive file names are findings without a line; templates and deleted files are not", () => {
  for (const p of [".env", "apps/web/.env.production", "deploy/prod.env", "home/.ssh/id_ed25519", "k/store.jks", "a/.netrc", "infra/terraform.tfstate"]) {
    const fs = scan(patch(p, ["x"]));
    assert.deepEqual(fs, [{ rule: "sensitive-filename", path: p }], p);
  }
  for (const p of [".env.example", "a/.env.sample", "id_ed25519.pub", "src/environment.ts", "docs/env.md"]) assert.deepEqual(scan(patch(p, ["x"])), [], p);
  const gone = "diff --git a/.env b/.env\ndeleted file mode 100644\nindex 1111111..0000000\n--- a/.env\n+++ /dev/null\n@@ -1 +0,0 @@\n-x=1\n";
  assert.deepEqual(scan(gone), []);
});
