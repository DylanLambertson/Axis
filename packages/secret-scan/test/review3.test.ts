// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Findings of the third review: the code guard matches the shape of code, so generated secrets with brackets are found.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isDigestName } from "../src/index.js";
import { canary, hexOf, patch, randomValue, rnd, rules, scan } from "./helpers.js";

const one = (line: string, path = "src/a.py") => scan(patch(path, [line]));
const GENERIC = ["generic-secret-assignment"];
const DJANGO = "abcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*(-_=+)";
const SYMBOLS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()_+-=[]{}|:<>?~";
const recall = (n: number, make: (i: number) => string): number => {
  let hit = 0;
  for (let i = 1; i <= n; i++) if (one(make(i)).some((f) => f.rule === "generic-secret-assignment")) hit++;
  return hit / n;
};

test("B-1 recall: Django-style secret keys (50 characters with punctuation and brackets) are found", () => {
  const plain = recall(1000, (i) => `SECRET_KEY = '${rnd(i, 50, DJANGO)}'`);
  const prefixed = recall(1000, (i) => `SECRET_KEY = 'django-insecure-${rnd(i, 50, DJANGO)}'`);
  assert.ok(plain >= 0.9, `recall ${plain}`);
  assert.ok(prefixed >= 0.94, `recall with prefix ${prefixed}`);
});

test("B-1 recall: generated passwords with symbols and brackets are found", () => {
  const r = recall(1000, (i) => `DB_PASSWORD="${rnd(i, 20, SYMBOLS)}"`);
  assert.ok(r >= 0.75, `recall ${r}`);
});

test("B-1 recall: secrets with brackets and optional chains inside, and next to code", () => {
  const v = randomValue(21, 30);
  const cases = [
    `password=p@ss(w0rd)abc123XYZ`,
    `password="p@ss(w0rd)abc123XYZ"`,
    `token = "${v.slice(0, 10)}]${v.slice(10)}"`,
    `token = "${v.slice(0, 10)}#[${v.slice(10)}"`,
    `api_key: '${v.slice(0, 12)}#{${v.slice(12)}'`,
    `api_key: '${v.slice(0, 12)}?.7${v.slice(12)}'`,
    `secret="Xk9#(pQ2)vL!m[7Zr${v.slice(0, 6)}"`,
    `foo(bar); connect(password="${v.slice(0, 8)}#(x)${v.slice(8)}")`,
    `cfg = {token: "${v.slice(0, 5)}){${v.slice(5)}"}`,
  ];
  for (const c of cases) assert.deepEqual(rules(one(c)), GENERIC, c.slice(0, 24));
});

test("B-1: the five Axis lines, regex literals and common call shapes stay quiet", () => {
  const quiet = [
    "maxOutputTokens: z.number().int().min(1).max(MAX_OUTPUT_TOKENS),",
    "inputTokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),",
    "token: randomBytes(8).toString('hex'),",
    "const SECRET_LINE = /^[A-Za-z0-9_]*(?:secret|token)[A-Za-z0-9_]*\\s*[:=]/;",
    "const TOKEN_RE = /[0-9A-Za-z_-]+\\.[0-9A-Za-z_-]+/;",
    "this.accessToken = this.options.credentials?.getAccessToken2(scope),",
    "const apiKey = config.get<string>('provider.apiKey2') ?? fallback,",
    "authToken: () => resolveAuthTokenFromStorage2(),",
    "secret: items.map((x) => x.value2)[index],",
    "token=this.options.accessToken2",
  ];
  for (const l of quiet) assert.deepEqual(one(l), [], l);
});

test("B-1 guard: every alternative of the code shape rejects a value that is otherwise key-like", () => {
  const cases: [string, string][] = [
    ["a call", "resolveAccessToken2Value(arg)"],
    ["a member call", "client.fetchAccessToken2Value(arg)"],
    ["an index", "items2OfTheAccessList[index]"],
    ["a block", "lookup2TableOfValues{abc}"],
    ["a generic call", "getValue2OfTheToken<string>(arg)"],
    ["a call in parentheses", "(resolveTheValue2Token(x))"],
    ["an optional chain", "config2value?.accessToken"],
    ["an arrow", "value2=>resolveTheTokenValue"],
    ["a chained call", "9x(7).tokenValue2abcdef"],
    ["a chained index", "9x[7].tokenValue2abcdef"],
  ];
  for (const [what, value] of cases) {
    assert.deepEqual(one(`api_key = ${value}`), [], what);
    // The same value without the shape is a secret, so the guard is what quiets it.
    assert.deepEqual(rules(one(`api_key = ${value.replace(/[()[\]{}<>?.=]/g, "")}`)), GENERIC, `${what} (stripped)`);
  }
});

test("B-1 guard: a regex literal is code, a value that only starts with a slash is not", () => {
  assert.deepEqual(one("api_key = /^[0-9A-Fa-f]{2}(?:-[0-9A-Fa-f]{2})+$/"), []);
  assert.deepEqual(one("api_key = /^\\d{3}-[A-Z]\\w+2Abc9$/"), []);
  const v = randomValue(22, 30);
  assert.deepEqual(rules(one(`api_key = /${v}`)), GENERIC);
});

test("N-1: glued and plural secret words keep a name a secret name", () => {
  for (const name of ["sha_webhooksecret", "commit_apitoken", "SHA_ACCESSTOKEN", "etag_privatekey", "sha_clientsecret", "HASH_SECRETKEY", "commit_signingkey", "SHA_SECRETS", "commit_tokens", "sha_passwords", "GITHUB_WEBHOOK_SHA256_SECRETKEY"]) {
    assert.deepEqual(rules(one(`${name}=${hexOf(31, 64)}`)), GENERIC, name);
    assert.equal(isDigestName(name), false, name);
  }
  assert.equal(isDigestName("sha_oauth"), false);
  for (const name of ["tokenizer_sha", "commit_sha", "sha_key", "hash_key", "ETAG_KEY"]) assert.equal(isDigestName(name), true, name);
});

test("N-3: any word_key name is a key name; hex digests under hash and etag key names are digests, other values are secrets", () => {
  const v = randomValue(23, 32);
  for (const name of ["HMAC_KEY", "WEBHOOK_KEY", "HASH_KEY", "ETAG_KEY", "HMAC_SHA256_KEY", "thumbprint_key", "MY_KEY", "my-key", "cache_key"]) {
    assert.deepEqual(rules(one(`${name} = "${v}"`)), GENERIC, name);
  }
  for (const name of ["HASH_KEY", "ETAG_KEY", "sha_key", "commit_key"]) assert.deepEqual(one(`${name} = "${hexOf(32, 40)}"`), [], name);
  for (const name of ["HMAC_KEY", "MY_KEY", "WEBHOOK_KEY"]) assert.deepEqual(rules(one(`${name} = "${hexOf(33, 64)}"`)), GENERIC, name);
  // A bare `key` is still not a credential name.
  assert.deepEqual(one(`key = "${v}"`), []);
});

test("N-2: every default-ignorable and format character, and the Braille blank, is folded", () => {
  const v = randomValue(24, 36);
  const k = canary.aws(9);
  for (const ch of ["؜", "⁪", "ㅤ", "ᅟ", "ᅠ", "ﾠ", "￹", "\u{1d173}", "឴", "⠀", "⁠", "️", "\u{110bd}"]) {
    assert.deepEqual(rules(one(`api_key=${ch.repeat(100)}${v}`)), GENERIC, JSON.stringify(ch));
    assert.deepEqual(rules(one(`api_key${ch}=${ch}"${v}"`)), GENERIC, JSON.stringify(ch));
    assert.deepEqual(rules(one(`x=${k.slice(0, 9)}${ch}${k.slice(9)}`)), ["aws-access-key-id"], JSON.stringify(ch));
  }
});

test("N-5: a value that ends in `>` or starts with `<` is a placeholder; one with `>` inside is not", () => {
  assert.deepEqual(one("password = <insert-the-real-secret-here2>"), []);
  assert.deepEqual(one("password = <the-database-password-value2"), []);
  const v = randomValue(25, 30);
  assert.deepEqual(rules(one(`password = "${v.slice(0, 9)}<>${v.slice(9)}"`)), GENERIC);
});
