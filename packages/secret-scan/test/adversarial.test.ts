// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Inputs that make a backtracking or quadratic scan stall. The time bound is loose on purpose (a slow CI machine): what
// it must catch is exponential or quadratic growth, which takes minutes, not a few seconds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_LIMITS, createSecretScanner, scanText } from "../src/index.js";
import { canary, patch, rules, scan } from "./helpers.js";

const MB = 1024 * 1024;
const LIMIT_MS = 15_000;

function timed<T>(f: () => T): { out: T; ms: number } {
  const t = performance.now();
  const out = f();
  return { out, ms: performance.now() - t };
}

const repeat = (unit: string, bytes = MB): string => unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes);

const shapes: Record<string, string> = {
  plain: repeat("a"),
  "name repeats": repeat("secret="),
  "keyword suffix": repeat("token") + "=",
  "scheme repeats": repeat("://"),
  "url with colons": "http://" + repeat("a:"),
  "url with ats": "http://a:b" + repeat("@"),
  "user without end": "http://" + repeat("a"),
  "begin repeats": repeat("-----BEGIN "),
  "begin words": "-----BEGIN " + repeat("A "),
  "bearer repeats": repeat("bearer "),
  "bearer long": "bearer " + repeat("a"),
  "basic long": "basic " + repeat("A"),
  "jwt head": "eyJ" + repeat("a"),
  "jwt dots": repeat("eyJaaaaaaaaaa."),
  "key prefixes": repeat("AKIA"),
  "github prefix": repeat("ghp_"),
  "base64 run": repeat("A"),
  "many runs": repeat(`${"a".repeat(30)} `),
  "hex run": repeat("0"),
  "many hex runs": repeat(`${"0".repeat(44)} `),
  "connection string": repeat("Server=a;"),
  "connection string x": "Server=a;" + repeat("x;"),
  "assignment values": repeat("key=" + "a".repeat(300) + " "),
  "zero width": repeat("a\u200b"),
  "non ascii": repeat("\u00e9\u3042"),
  "nfkc expansion": repeat("\ufdfa"),
  "cr only": repeat("a\rb"),
};

test("linear-time: a 1 MiB single line of each hostile shape finishes, as a patch line and as a message", () => {
  for (const [name, line] of Object.entries(shapes)) {
    const asPatch = timed(() => scanText(patch("a.txt", [line]), {}, DEFAULT_LIMITS, () => 0));
    assert.ok(asPatch.ms < LIMIT_MS, `${name} (patch): ${asPatch.ms} ms`);
    const asMessage = timed(() => scanText(line, { part: "message" }, DEFAULT_LIMITS, () => 0));
    assert.ok(asMessage.ms < LIMIT_MS, `${name} (message): ${asMessage.ms} ms`);
  }
});

test("doubling the input does not much more than double the time (not quadratic)", () => {
  for (const name of ["name repeats", "scheme repeats", "bearer repeats", "assignment values", "many runs"]) {
    const unit = (shapes[name] as string).slice(0, 4096);
    const run = (n: number): number => timed(() => scan(patch("a.txt", [repeat(unit, n)]))).ms;
    run(256 * 1024); // warm up
    const small = Math.max(run(512 * 1024), 20);
    const big = run(2 * MB);
    assert.ok(big < small * 12 + 200, `${name}: ${small} ms then ${big} ms for four times the input`);
  }
});

test("a long line is scanned in overlapping windows: a secret at the end, the middle and across a window edge is found", () => {
  const key = canary.aws(7);
  const w = DEFAULT_LIMITS.maxLineLength;
  const pad = (n: number): string => "x ".repeat(n / 2);
  for (const at of [0, w / 2, w - 10, w - 3, w, 3 * w - 7, MB - 40]) {
    const line = pad(at) + " " + key + " " + pad(MB - at);
    assert.deepEqual(rules(scan(patch("a.txt", [line]))), ["aws-access-key-id"], `at ${at}`);
  }
  // One finding per rule and line, however many windows hold a match.
  assert.equal(scan(patch("a.txt", [repeat(`${key} `)])).length, 1);
});

test("the findings cap holds: 150,000 matching lines give 100,000 findings and an incomplete scan", () => {
  const line = canary.aws(1);
  const text = patch("a.txt", Array.from({ length: 150_000 }, () => line));
  const { out, ms } = timed(() => scanText(text, {}, DEFAULT_LIMITS, () => 0));
  assert.equal(out.findings.length, 100_000);
  assert.deepEqual(out.incomplete, ["findings_capped"]);
  assert.ok(ms < LIMIT_MS, `${ms} ms`);
  const small = scanText(text, {}, { ...DEFAULT_LIMITS, maxFindings: 7 }, () => 0);
  assert.equal(small.findings.length, 7);
});

test("the cap also bounds one very long line of distinct findings across many windows", () => {
  const fs = scanText(patch("a.txt", [repeat(`${canary.aws(2)} `, 4 * MB)]), {}, DEFAULT_LIMITS, () => 0).findings;
  assert.equal(fs.length, 1);
});

test("the cap holds inside one line that matches several rules", () => {
  const line = [canary.aws(1), canary.github(1), canary.gitlab(1), canary.npm(1), canary.stripe(1)].join(" ");
  assert.equal(scan(patch("a.txt", [line])).length, 5);
  const out = scanText(patch("a.txt", [line, line]), {}, { ...DEFAULT_LIMITS, maxFindings: 2 }, () => 0);
  assert.equal(out.findings.length, 2);
  assert.deepEqual(out.incomplete, ["findings_capped"]);
});

test("a patch of a million tiny lines is bounded by the byte limit and the cap", async () => {
  const text = patch("a.txt", Array.from({ length: 300_000 }, (_, i) => `v${i}`));
  const s = createSecretScanner({ mode: "refuse", maxBytes: 1 * MB });
  assert.ok(text.length > MB);
  await assert.rejects(s.scan(text, {}), /could not cover/);
});

test("many files and many hunks: the reader state stays linear", () => {
  const parts: string[] = [];
  for (let i = 0; i < 20_000; i++) parts.push(patch(`d/f${i}.txt`, [`line ${i}`]));
  const { out, ms } = timed(() => scanText(parts.join(""), {}, DEFAULT_LIMITS, () => 0));
  assert.equal(out.findings.length, 0);
  assert.ok(ms < LIMIT_MS, `${ms} ms`);
});

test("a path of a million characters is cut", () => {
  const p = "p".repeat(MB);
  const fs = scan(patch(p, [canary.aws(1)]));
  assert.equal(fs.length, 1);
  assert.ok((fs[0]?.path?.length ?? 0) <= 4096);
});
