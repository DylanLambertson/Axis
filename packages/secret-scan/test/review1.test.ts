// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Findings of the first review: decoys must not hide a real secret, and every fail-closed path is held by a test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_LIMITS, createSecretScanner, scanText, SecretScanError } from "../src/index.js";
import { canary, hexOf, patch, randomValue, rnd, rules, scan } from "./helpers.js";

const one = (line: string, limits = {}) => scan(patch("src/a.ts", [line]), {}, limits);

test("B-1: a real key after many decoy getters in a minified bundle is found", () => {
  for (const n of [1, 31, 32, 33, 500, 5000]) {
    const getters = Array.from({ length: n }, (_, i) => `getAccessToken${i}:function(){return this.t}`).join(",");
    const fs = one(`var c={${getters},apiKey:"${randomValue(n, 32)}"}`);
    assert.deepEqual(rules(fs), ["generic-secret-assignment"], `${n} decoys`);
  }
});

test("B-1: a real URL password after many weak ones is found", () => {
  for (const n of [31, 32, 33, 2000]) {
    const weak = Array.from({ length: n }, () => "https://admin:admin@h").join(" ");
    assert.deepEqual(rules(one(`${weak} https://bob:${randomValue(n, 24)}@db.internal`)), ["url-credentials"], `${n} decoys`);
  }
});

test("B-1: a secret embedded in a rejected value is found (a URL after a name, a flag, a path)", () => {
  const v = randomValue(3, 32);
  assert.deepEqual(rules(one(`TOKEN_URL=https://auth.host/oauth?client_secret=${v}`)), ["generic-secret-assignment"]);
  assert.deepEqual(rules(one(`token=https://auth.host/oauth?x=1&api_key=${v}`)), ["generic-secret-assignment"]);
  assert.deepEqual(rules(one(`password=--token=${v}`)), ["generic-secret-assignment"]);
});

test("B-1: the work spent on decoys is bounded, and running out of it is incomplete, never a silent pass", async () => {
  const weak = Array.from({ length: 50 }, () => "https://admin:admin@h").join(" ");
  const text = patch("a.txt", [`${weak} https://bob:${randomValue(1, 24)}@db.internal`]);
  const out = scanText(text, {}, { ...DEFAULT_LIMITS, maxRejectedMatches: 10 }, () => 0);
  assert.deepEqual(out.incomplete, ["budget"]);
  await assert.rejects(createSecretScanner({ mode: "refuse", maxRejectedMatches: 10 }).scan(text, {}), (e: unknown) => e instanceof SecretScanError && e.code === "budget");
  assert.deepEqual(rules(await createSecretScanner({ mode: "warn", maxRejectedMatches: 10 }).scan(text, {})), ["scan-incomplete"]);
  // Enough budget: complete, and found.
  assert.deepEqual(rules(await createSecretScanner({ mode: "refuse", maxRejectedMatches: 60 }).scan(text, {})), ["url-credentials"]);
});

test("S-1: 40 and 64 digit hex under key, token and secret names is key material", () => {
  for (const [name, len] of [["PRIVATE_KEY", 64], ["ENCRYPTION_KEY", 64], ["signing_key", 64], ["SENTRY_AUTH_TOKEN", 64], ["api_key", 40], ["GITHUB_TOKEN", 40], ["master_key", 64]] as const) {
    assert.deepEqual(rules(one(`${name}=${hexOf(len, len)}`)), ["generic-secret-assignment"], name);
  }
  for (const name of ["tokenizer_sha", "tokenizer_hash", "tokenizerDigest", "tokenizer_checksum", "tokenizerRev"]) {
    assert.deepEqual(one(`${name}=${hexOf(7, 40)}`), [], name);
  }
});

test("S-2: a value that starts with a slash, dash, dot, tilde or star is not rejected for that alone", () => {
  const v = randomValue(9, 31);
  for (const lead of ["/", "-", ".", "~", "*"]) assert.deepEqual(rules(one(`api_key=${lead}${v}`)), ["generic-secret-assignment"], lead);
  assert.deepEqual(one("token=./scripts/run/the-build-step2"), []);
  assert.deepEqual(one("token=~/.config/some/long-path-name2"), []);
  assert.deepEqual(one("token=--some-long-option=value2value"), []);
});

test("S-3: an allowed binary is neither reported nor scanned past the budget; others still are", () => {
  const body = [canary.aws(1), ...Array.from({ length: 20 }, (_, i) => rnd(i, 100))];
  const ctx = { binaryPaths: ["a.bin"], allowedBinaryPaths: ["a.bin"] };
  assert.deepEqual(scan(patch("a.bin", body), ctx, { maxBinaryBytes: 500 }), [{ rule: "aws-access-key-id", path: "a.bin", line: 1 }]);
  assert.deepEqual(rules(scan(patch("a.bin", body), { binaryPaths: ["a.bin"], allowedBinaryPaths: ["other.bin"] }, { maxBinaryBytes: 500 })), ["aws-access-key-id", "binary-unscanned"]);
  const marker = "diff --git a/i.png b/i.png\nnew file mode 100644\nindex 0000000..1111111\nBinary files /dev/null and b/i.png differ\n";
  assert.deepEqual(scan(marker, { allowedBinaryPaths: ["i.png"] }), []);
  assert.deepEqual(rules(scan(marker, { allowedBinaryPaths: ["i.png.bak"] })), ["binary-unscanned"]);
  // Only the first 50 entries count.
  const many = [...Array.from({ length: 50 }, (_, i) => `f${i}`), "i.png"];
  assert.deepEqual(rules(scan(marker, { allowedBinaryPaths: many })), ["binary-unscanned"]);
});

test("S-4: padding between a name and its value cannot hide it, nor push it over a window edge", () => {
  const v = randomValue(4, 36);
  assert.deepEqual(rules(one(`api_key=${" ".repeat(20_000)}${v}`)), ["generic-secret-assignment"]);
  assert.deepEqual(rules(one(`Authorization: Bearer${"\t".repeat(20_000)}${v}`)), ["bearer-token"]);
  assert.deepEqual(rules(one(`api_key${" ".repeat(64)}=${" ".repeat(64)}${v}`)), ["generic-secret-assignment"]);
  const w = DEFAULT_LIMITS.maxLineLength;
  const line = "x ".repeat((w - 300) / 2) + `api_key${" ".repeat(60)}=${" ".repeat(60)}"${randomValue(5, 256)}"`;
  assert.deepEqual(rules(one(line)), ["generic-secret-assignment"]);
  // Invisible padding is folded on the whole line.
  assert.deepEqual(rules(one(`${canary.aws(2).slice(0, 8)}${"​".repeat(30_000)}${canary.aws(2).slice(8)}`)), ["aws-access-key-id"]);
});

test("S-5: a match longer than any bounded overlap is found across a window edge", () => {
  const w = DEFAULT_LIMITS.maxLineLength;
  const jwt = "eyJ" + rnd(1, 1290) + ".eyJ" + rnd(2, 1290) + "." + rnd(3, 1290);
  for (const at of [w - 3500, w - 2500, w - 100, 2 * w - 3900]) {
    assert.deepEqual(rules(one("x ".repeat(at / 2) + jwt + " tail")), ["jwt"], `at ${at}`);
  }
  const assign = `api_key${" ".repeat(60)}=${" ".repeat(60)}"${randomValue(6, 256)}"`;
  for (const at of [w - 380, w - 200, w - 20]) assert.deepEqual(rules(one("x ".repeat(at / 2) + assign)), ["generic-secret-assignment"], `at ${at}`);
});

test("S-5: a deadline that passes inside one long line is incomplete, on a patch of a few lines", async () => {
  let t = 0;
  const now = (): number => (t += 1000);
  const text = patch("a.txt", ["y ".repeat(300_000)]);
  const out = scanText(text, {}, { ...DEFAULT_LIMITS, deadlineMs: 4500 }, now);
  assert.ok(out.incomplete.includes("deadline"));
  t = 0;
  await assert.rejects(createSecretScanner({ mode: "refuse", deadlineMs: 4500, now }).scan(text, {}), (e: unknown) => e instanceof SecretScanError && e.code === "deadline");
  // A clock that answers NaN has run out.
  await assert.rejects(createSecretScanner({ mode: "refuse", now: () => Number.NaN }).scan(patch("a.txt", ["x"]), {}), (e: unknown) => e instanceof SecretScanError && e.code === "deadline");
});

test("S-5: in warn mode a capped list says so with scan-incomplete", async () => {
  const lines = Array.from({ length: 20 }, (_, i) => canary.aws(i + 1));
  const warn = await createSecretScanner({ mode: "warn", maxFindings: 5 }).scan(patch("a.txt", lines), {});
  assert.equal(warn.length, 6);
  assert.equal(warn[5]?.rule, "scan-incomplete");
  const refuse = await createSecretScanner({ mode: "refuse", maxFindings: 5 }).scan(patch("a.txt", lines), {});
  assert.equal(refuse.length, 5);
});

test("S-5: entropy: a value of 16 distinct characters is a secret, one made of repeated pairs is not", () => {
  const distinct = ["a1b2", "c3d4", "e5f6", "g7h8"].join("");
  assert.deepEqual(rules(one(`api_key = "${distinct}"`)), ["generic-secret-assignment"]);
  assert.deepEqual(one(`api_key = "${["a1a1", "a1a1", "b2b2", "b2b2"].join("")}"`), []);
});

test("S-5: a deleted file is never named, even when a stray `+++` follows", () => {
  const t = "diff --git a/.env b/.env\ndeleted file mode 100644\n+++ b/.env\n";
  assert.deepEqual(scan(t), []);
});

test("S-5: CRLF on every line, headers included, leaves the path clean", () => {
  const text = patch(".env", [canary.aws(3)]).split("\n").join("\r\n");
  assert.deepEqual(scan(text), [{ rule: "sensitive-filename", path: ".env" }, { rule: "aws-access-key-id", path: ".env", line: 1 }]);
});

test("N-1: a part that is not `patch` is read as plain text", () => {
  const msg = `subject\n\n${canary.aws(4)}\n`;
  assert.deepEqual(rules(scan(msg, { part: "Message" as never })), ["aws-access-key-id"]);
  assert.deepEqual(rules(scan(msg, { part: "message" })), ["aws-access-key-id"]);
});

test("N-2: variation selectors, joiners and tag characters inside a token are folded away", () => {
  const k = canary.aws(5);
  for (const ch of ["️", "͏", "\u{e0041}"]) assert.deepEqual(rules(one(`x=${k.slice(0, 7)}${ch}${k.slice(7)}`)), ["aws-access-key-id"]);
});

test("N-6: a token in a file name is reported by rule, on the path", () => {
  const gh = canary.github(6);
  const fs = scan(patch(`secrets/${gh}.txt`, ["plain"]));
  assert.deepEqual(fs, [{ rule: "github-token", path: `secrets/${gh}.txt` }]);
  assert.deepEqual(scan(patch("docs/notes-about-tokens.txt", ["plain"])), []);
});

test("unquote: every escape git writes", () => {
  const q = (p: string) => `diff --git "a/${p}" "b/${p}"\nnew file mode 100644\n--- /dev/null\n+++ "b/${p}"\n@@ -0,0 +1 @@\n+${canary.aws(7)}\n`;
  assert.equal(scan(q("a\\\\b"))[0]?.path, "a\\b");
  assert.equal(scan(q('a\\"b'))[0]?.path, 'a"b');
  assert.equal(scan(q("a\\tb"))[0]?.path, "a\tb");
  assert.equal(scan(q("a\\nb"))[0]?.path, "a\nb");
});
