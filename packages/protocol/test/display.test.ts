// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CC_CS_LS_RANGES, CF_RANGES, MAX_REVIEW_PATH, MIN_DISPLAY_LIMIT, REFUSED_DISPLAY, displayTextSchema, rangesToClass, toDisplayPath } from "../src/index.js";
import { FILE1, SHA1, diffResponse, file } from "./samples-p1b.js";
import { schemaOf } from "./suite.js";

const REFUSED = /[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/u;

function check(raw: string, max = MAX_REVIEW_PATH): string {
  const out = toDisplayPath(raw, max);
  assert.ok(out.length <= max, `${out.length} units for a limit of ${max}`);
  assert.equal(displayTextSchema(max).safeParse(out).success, true, "refused by displayTextSchema");
  assert.equal(REFUSED.test(out), false);
  assert.equal(toDisplayPath(raw, max), out, "not deterministic");
  return out;
}

test("toDisplayPath: every code point the schema refuses is escaped, alone and in a name", () => {
  let refused = 0;
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue; // lone surrogates are covered below
    const ch = String.fromCodePoint(cp);
    if (!REFUSED.test(ch)) continue;
    refused++;
    const out = check(`a${ch}b.txt`);
    assert.equal(out, `a\\u{${cp.toString(16)}}b.txt`);
  }
  assert.ok(refused > 100, `only ${refused} refused code points were tried`);
  // The 41 format code points `escapeForDisplay` of @axis/review leaves in place.
  const leftAlone = [0x600, 0x601, 0x602, 0x603, 0x604, 0x605, 0x6dd, 0x70f, 0x890, 0x891, 0x8e2, 0x110bd, 0x110cd, ...Array.from({ length: 16 }, (_, i) => 0x13430 + i), 0x1bca0, 0x1bca1, 0x1bca2, 0x1bca3, ...Array.from({ length: 8 }, (_, i) => 0x1d173 + i)];
  assert.equal(leftAlone.length, 41);
  for (const cp of leftAlone) assert.equal(check(`a${String.fromCodePoint(cp)}b.txt`), `a\\u{${cp.toString(16)}}b.txt`);
});

test("toDisplayPath: lone surrogates, NUL, ESC, bidi, tag characters and a backslash", () => {
  for (const raw of ["a\ud800b", "\udfff", "a\0b", "a\u001b[2Jb", "a\u202eb", "\u{e0041}\u{e0001}", "a\\u{41}b", "\\", "\u2028\u2029", "\u0085"]) check(raw);
  assert.equal(check("a\\u{41}"), "a\\\\u{41}", "a typed backslash cannot forge an escape");
  assert.equal(check("plain/src/a.ts"), "plain/src/a.ts");
  assert.equal(check(""), "");
  assert.equal(check("café/日本語.ts"), "café/日本語.ts");
  assert.equal(check("\u{1f600}.txt"), "\u{1f600}.txt");
});

test("toDisplayPath: the bound is on the escaped text (a 71-character name that escapes to 281 units)", () => {
  const out = check(`f${"\u0001".repeat(70)}`);
  assert.ok(out.length <= MAX_REVIEW_PATH);
  assert.equal(check("\t".repeat(130)).length <= MAX_REVIEW_PATH, true);
  assert.ok(check("\u{e0001}".repeat(500)).includes("…"));
});

test("toDisplayPath: long, hostile and astral names always fit, for any limit from the minimum up", () => {
  const nasty = ["x".repeat(100_000), "\u{10ffff}".repeat(3000), "\ud800".repeat(2000), "\u202e".repeat(40) + "a".repeat(400), `${"a/".repeat(300)}\0`, "\u{1f600}".repeat(5000)];
  for (const raw of nasty) for (const max of [MIN_DISPLAY_LIMIT, 25, 31, 64, 100, 255, MAX_REVIEW_PATH]) check(raw, max);
  assert.throws(() => toDisplayPath("a", MIN_DISPLAY_LIMIT - 1), RangeError);
  assert.throws(() => toDisplayPath("a", 1.5), RangeError);
  assert.throws(() => toDisplayPath(1 as unknown as string, 64), TypeError);
});

test("toDisplayPath: a cut keeps the head and the tail, and cuts on code point boundaries", () => {
  const raw = `${"a".repeat(200)}/${"\u{1f600}".repeat(100)}/end.txt`;
  const out = check(raw);
  assert.ok(out.startsWith("aaaa") && out.endsWith("end.txt") && out.includes("…"));
  assert.equal(out.includes("�"), false);
  assert.equal(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(out), false, "a surrogate pair was split");
});

test("two long paths that differ only in the cut-out middle collide as text but not as files, and the response is accepted", () => {
  const a = `${"d/".repeat(80)}moduleA/${"e/".repeat(80)}x.ts`;
  const b = `${"d/".repeat(80)}moduleB/${"e/".repeat(80)}x.ts`;
  assert.equal(check(a), check(b), "the cut hides the difference");
  const entry = (id: string, raw: string) => ({ ...structuredClone(file), fileId: id, displayPath: toDisplayPath(raw, MAX_REVIEW_PATH) });
  const res = schemaOf("axis.review", "diff", "response");
  const reply = { ...structuredClone(diffResponse), files: [entry(FILE1, a), entry("3".repeat(64), b)] };
  assert.equal(reply.files[0]?.displayPath, reply.files[1]?.displayPath);
  assert.equal(res.safeParse(reply).success, true);
  assert.equal(res.safeParse({ ...reply, files: [entry(FILE1, a), entry(FILE1, b)] }).success, false, "equal ids are still refused");
  void SHA1;
});

test("a response of hostile names, each passed through toDisplayPath, is always accepted", () => {
  const res = schemaOf("axis.review", "diff", "response");
  const names = ["a؀b", "\u202e", "x".repeat(400), "f" + "\u0001".repeat(70), "\u{e0001}".repeat(40), "a\ud800", "\0", "\u001b[31m"];
  const files = names.map((n, i) => ({ ...structuredClone(file), fileId: String(i + 1).padStart(64, "0"), displayPath: toDisplayPath(n, MAX_REVIEW_PATH), displayOldPath: toDisplayPath(n, MAX_REVIEW_PATH) }));
  assert.equal(res.safeParse({ ...structuredClone(diffResponse), files }).success, true);
  // Without the function the escapes are missing, and the schema refuses the same names.
  for (const n of ["a\u0600b", "\u202e", "x".repeat(400)]) {
    assert.equal(res.safeParse({ ...structuredClone(diffResponse), files: [{ ...structuredClone(file), displayPath: n }] }).success, false);
  }
});

test("the refused set is explicit data and equals the property classes of the Unicode version it was generated from", () => {
  // If a newer engine adds a format code point this fails on purpose: extend CF_RANGES on every side together (display.ts).
  const property = /[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/u;
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    const ch = String.fromCodePoint(cp);
    assert.equal(REFUSED_DISPLAY.test(ch), property.test(ch), `U+${cp.toString(16)}`);
  }
  assert.ok(CF_RANGES.length > 10 && CC_CS_LS_RANGES.length > 3);
  assert.equal(new RegExp(`[${rangesToClass([0x41, [0x61, 0x63]])}]`, "u").source, "[\\u{41}\\u{61}-\\u{63}]");
  assert.equal(displayTextSchema(10).safeParse("a\u0600").success, false);
});

test("toDisplayPath: a literal ellipsis is escaped, so an ellipsis in the output always means a cut", () => {
  assert.equal(check("a\u2026b"), "a\\u{2026}b");
  const cutOut = check("x".repeat(400));
  assert.equal(cutOut.split("\u2026").length - 1, 1);
  assert.equal(check(`${"a".repeat(100)}\u2026${"b".repeat(100)}`).includes("\\u{2026}"), true);
});

test("toDisplayPath: the limit is exact on the escaped length (max stays whole, max + 1 is cut)", () => {
  const max = 40;
  // 35 plain characters plus one 5-unit escape (\u{1}) is 40 units: kept whole. One more plain character makes 41: cut.
  const whole = `${"a".repeat(35)}\u0001`;
  assert.equal(toDisplayPath(whole, max), `${"a".repeat(35)}\\u{1}`);
  assert.equal(toDisplayPath(whole, max).length, max);
  const over = toDisplayPath(`${whole}b`, max);
  assert.ok(over.includes("\u2026") && over.length <= max);
  assert.equal(toDisplayPath("a".repeat(max), max), "a".repeat(max));
  assert.ok(toDisplayPath("a".repeat(max + 1), max).includes("\u2026"));
  // Five-unit escapes: 8 of them (40 units) fit 40, 9 (45) do not.
  assert.equal(toDisplayPath("\u0001".repeat(8), max), "\\u{1}".repeat(8));
  assert.ok(toDisplayPath("\u0001".repeat(9), max).includes("\u2026"));
});
