// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Findings of the second review: digest names are whole words, code is not a credential, and the last gaps in padding and caps.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_LIMITS, createSecretScanner, isDigestName, looksRandom, scanText } from "../src/index.js";
import { canary, hexOf, patch, randomValue, rnd, rules, scan } from "./helpers.js";

const one = (line: string, limits = {}) => scan(patch("src/a.ts", [line]), {}, limits);

test("SF-1: sha and hash inside a longer word do not make a secret a digest", () => {
  for (const [name, len] of [["SHARED_SECRET", 64], ["WEBHOOK_SHARED_SECRET", 64], ["SHARED_ACCESS_KEY", 64], ["HASHICORP_VAULT_TOKEN", 40], ["MARSHAL_TOKEN", 40], ["sharedSecret", 64]] as const) {
    assert.deepEqual(rules(one(`${name}=${hexOf(len, len)}`)), ["generic-secret-assignment"], name);
  }
});

test("SF-1: a name with both a digest word and a secret word is a secret", () => {
  for (const name of ["commit_token", "token_sha", "tokenHash", "secret_digest", "api_key_checksum", "TOKEN_ETAG"]) {
    assert.deepEqual(rules(one(`${name}=${hexOf(8, 40)}`)), ["generic-secret-assignment"], name);
  }
});

test("SF-1: names that are digests by whole words", () => {
  for (const n of ["commit_sha", "file_hash", "etag", "ETag", "contentDigest", "git-rev", "tree_oid", "SHA256", "sha1_checksum", "md5", "integrity"]) assert.equal(isDigestName(n), true, n);
  for (const n of ["SHARED_SECRET", "hashicorp_token", "marshal", "api_key", "tokenHash", "revolution", "oidc_client", "rev_token", ""]) assert.equal(isDigestName(n), false, n);
  assert.equal(looksRandom(hexOf(1, 40), "commit_sha"), false);
  assert.equal(looksRandom(hexOf(1, 64), "file_hash"), false);
  assert.equal(looksRandom(hexOf(1, 40), "etag"), false);
  assert.equal(looksRandom(hexOf(1, 40), "SHARED_SECRET"), true);
});

test("SF-2: Axis's own code lines and common call shapes are not credentials", () => {
  const code = [
    "maxOutputTokens: z.number().int().min(1).max(MAX_OUTPUT_TOKENS),",
    "inputTokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),",
    "token: randomBytes(8).toString('hex'),",
    "const SECRET_LINE = /^[A-Za-z0-9_]*(?:secret|token)[A-Za-z0-9_]*\\s*[:=]/;",
    "this.accessToken = this.options.credentials?.getAccessToken2(scope),",
    "const apiKey = config.get<string>('provider.apiKey2') ?? fallback,",
    "password: (await readSecretFromTheVault(name))[0],",
    "authToken: () => resolveAuthTokenFromStorage2(),",
    "secret: items.map((x) => x.value2)[index],",
    "token=this.options.accessToken2",
    "token=this.options?.accessToken2Value",
    "secret=value=>resolveTheValue2Now",
    "token=items[index2ofTheItemList]",
    "api_key=lookup{abc2defghijklmnop",
  ];
  for (const l of code) assert.deepEqual(one(l), [], l);
});

test("SF-2: a real secret next to code on the same line is still found", () => {
  const v = randomValue(12, 36);
  assert.deepEqual(rules(one(`foo(bar); token=${v}`)), ["generic-secret-assignment"]);
  assert.deepEqual(rules(one(`x = z.number().int(); api_key: "${v}", y = f(x)`)), ["generic-secret-assignment"]);
  assert.deepEqual(rules(one(`connect(password=${v})`)), ["generic-secret-assignment"]);
  assert.deepEqual(rules(one(`cfg = {token:${v}}; list[0] = [api_key=${v}]`)), ["generic-secret-assignment"]);
  assert.deepEqual(rules(one(`call(a, b) && secret = '${v}' || other(c)`)), ["generic-secret-assignment"]);
});

test("N-1: NBSP, ideographic space, form feed and control padding cannot hide a value", () => {
  const v = randomValue(13, 36);
  for (const pad of [" ".repeat(100), "　".repeat(20_000), "\f", "   ", " ", "\u0001\u0002"]) {
    assert.deepEqual(rules(one(`api_key=${pad}${v}`)), ["generic-secret-assignment"], JSON.stringify(pad.slice(0, 3)));
    assert.deepEqual(rules(one(`api_key${pad}=${pad}"${v}"`)), ["generic-secret-assignment"], JSON.stringify(pad.slice(0, 3)));
  }
  assert.deepEqual(rules(one(`Authorization: Bearer${" ".repeat(500)}${v}`)), ["bearer-token"]);
});

test("N-2: a findings cap hit inside the last long line still says so in warn mode", async () => {
  const line = `${canary.aws(1)} ${"z ".repeat(20_000)}${canary.github(1)} ${"z ".repeat(5000)}${canary.npm(1)}`;
  const text = patch("a.txt", [line]);
  const out = scanText(text, {}, { ...DEFAULT_LIMITS, maxFindings: 1 }, () => 0);
  assert.deepEqual(out.incomplete, ["findings_capped"]);
  assert.deepEqual(rules(await createSecretScanner({ mode: "warn", maxFindings: 1 }).scan(text, {})), ["aws-access-key-id", "scan-incomplete"]);
});

test("guard: a path needs a lower-case word segment; a base64-like value with slashes is a secret", () => {
  const seg = (s: number) => rnd(s, 9, "ABCDEFGHJKLMNP0123456789");
  const v = `/${seg(1)}/${seg(2)}/${seg(3)}`;
  assert.deepEqual(rules(one(`api_key=${v}`)), ["generic-secret-assignment"]);
  assert.deepEqual(one(`api_key=/usr/lib/${seg(4)}/node_modules/x2`), []);
});

test("guard: the deadline is also checked between lines, so a flood of short lines stops early", () => {
  let calls = 0;
  let t = 0;
  const now = (): number => { calls++; return (t += 1000); };
  const lines = Array.from({ length: 20_000 }, (_, i) => `short line ${i}`);
  const out = scanText(patch("a.txt", lines), {}, { ...DEFAULT_LIMITS, deadlineMs: 5000 }, now);
  assert.ok(out.incomplete.includes("deadline"));
  assert.ok(calls < 400, `${calls} clock reads`);
});

test("end to end: an allowed binary over the budget passes a refuse-mode scanner, an unlisted one does not", async () => {
  const body = Array.from({ length: 400 }, (_, i) => rnd(i, 1000));
  const text = patch("shots/a.png", body) + patch("shots/b.png", body);
  const s = createSecretScanner({ mode: "refuse" });
  const ctx = { binaryPaths: ["shots/a.png", "shots/b.png"], part: "patch" as const, commit: "f".repeat(40) };
  assert.deepEqual(await s.scan(text, { ...ctx, allowedBinaryPaths: ["shots/a.png", "shots/b.png"] }), []);
  assert.deepEqual(await s.scan(text, { ...ctx, allowedBinaryPaths: ["shots/a.png"] }), [{ rule: "binary-unscanned", path: "shots/b.png", commit: "f".repeat(40) }]);
});
