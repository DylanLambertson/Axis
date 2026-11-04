// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { escapeForDisplay, pathProblem, symlinkEscapes } from "../src/index.js";

test("newlines, quotes, carriage returns and tabs in a name are written out, not interpreted", () => {
  assert.equal(escapeForDisplay('a "q"\nb\rc\td'), 'a "q"\\nb\\rc\\td');
});

test("a backslash is doubled so an escape in the output cannot be forged by the input", () => {
  assert.equal(escapeForDisplay("a\\nb"), "a\\\\nb");
  assert.notEqual(escapeForDisplay("a\\nb"), escapeForDisplay("a\nb"));
});

test("terminal escapes, DEL and C1 controls are escaped", () => {
  assert.equal(escapeForDisplay("\u001b[31mred\u001b[0m"), "\\x1b[31mred\\x1b[0m");
  assert.equal(escapeForDisplay("\u007f\u0085\u009b"), "\\x7f\\x85\\x9b");
});

test("every bidirectional control and invisible character is escaped, so a name reads as it is stored", () => {
  const spoof = "invoice\u202egpj.exe\u202c\u2066x\u2069\u200e\u200f\u061c\u200b\u2060\ufeff\u00ad";
  const out = escapeForDisplay(spoof);
  for (const ch of spoof.match(/[\u202a-\u202e\u2066-\u2069\u200b-\u200f\u061c\u2060\ufeff\u00ad]/gu) ?? []) assert.ok(!out.includes(ch), `U+${ch.codePointAt(0)?.toString(16)} must be escaped`);
  assert.match(out, /\\u\{202e\}/);
  assert.equal(out.length > spoof.length, true);
});

test("line and paragraph separators and the tag block are escaped", () => {
  assert.equal(escapeForDisplay("a\u2028b\u2029c"), "a\\u{2028}b\\u{2029}c");
  assert.equal(escapeForDisplay("\u{e0041}"), "\\u{e0041}");
});

test("a lone surrogate and non-characters are escaped and nothing throws", () => {
  assert.equal(escapeForDisplay("a\ud800b"), "a\\u{d800}b");
  assert.equal(escapeForDisplay("\ufffe\uffff"), "\\u{fffe}\\u{ffff}");
  assert.equal(escapeForDisplay("\u{1fffe}"), "\\u{1fffe}");
  assert.equal(escapeForDisplay("😀"), "😀");
});

test("a tab can be kept for hunk text and is escaped for names", () => {
  assert.equal(escapeForDisplay("a\tb", { keepTab: true }), "a\tb");
  assert.equal(escapeForDisplay("a\tb"), "a\\tb");
});

test("the result is cut after maxLength code points, never inside a pair", () => {
  assert.equal(escapeForDisplay("abcdef", { maxLength: 3 }), "abc\u2026");
  assert.equal(escapeForDisplay("😀😀😀", { maxLength: 2 }), "😀😀\u2026");
  assert.equal(escapeForDisplay("abc", { maxLength: 3 }), "abc");
  assert.ok(escapeForDisplay("x".repeat(10_000_000), { maxLength: 512 }).length <= 513);
});

test("a long path is cut in the middle so the file name at its end survives", () => {
  const p = `${"d/".repeat(400)}evil.sh`;
  const out = escapeForDisplay(p, { maxLength: 60, cut: "middle" });
  assert.ok(out.endsWith("evil.sh"));
  assert.ok(out.includes("\u2026"));
  assert.ok(Array.from(out).length <= 61);
  assert.equal(escapeForDisplay("short/path", { maxLength: 60, cut: "middle" }), "short/path");
  const huge = `${"x".repeat(5_000_000)}/name.txt`;
  const t = Date.now();
  assert.ok(escapeForDisplay(huge, { maxLength: 100, cut: "middle" }).endsWith("/name.txt"));
  assert.ok(Date.now() - t < 500);
  assert.ok(escapeForDisplay("😀".repeat(500), { maxLength: 9, cut: "middle" }).includes("\u2026"));
});

test("anything that is not a string is shown as empty, not as a crash", () => {
  assert.equal(escapeForDisplay(undefined as unknown as string), "");
  assert.equal(escapeForDisplay({} as unknown as string), "");
});

test("pathProblem refuses traversal, absolute and git-directory paths in every spelling", () => {
  const bad: Array<[string, string]> = [
    ["", "empty"], ["../x", "dot_segment"], ["a/../../x", "dot_segment"], ["./x", "dot_segment"], ["a//b", "empty_segment"], ["a/", "empty_segment"],
    ["/etc/passwd", "absolute"], ["\\\\server\\share", "absolute"], ["C:\\x", "absolute"], ["c:x", "absolute"], ["a\\..\\b", "backslash"],
    [".git/hooks/pre-commit", "git_dir"], ["a/.GIT/config", "git_dir"], [".git./x", "git_dir"], [".git /x", "git_dir"], ["git~1/x", "git_dir"],
    ["a\0b", "nul"], ["x".repeat(4097), "too_long"], [".git::$INDEX_ALLOCATION/x", "colon"],
  ];
  for (const [p, why] of bad) assert.equal(pathProblem(p), why, JSON.stringify(p));
  for (const ok of ["a", "a/b.txt", ".github/workflows/ci.yml", ".gitignore", ".gitmodules", "dir/.gitkeep", 'we"ird\nname', "..x", "x..", "a/.. b"]) {
    assert.equal(pathProblem(ok), undefined, JSON.stringify(ok));
  }
});

test("symlinkEscapes judges the target text alone", () => {
  assert.equal(symlinkEscapes("l", "a.txt"), false);
  assert.equal(symlinkEscapes("d/l", "../a.txt"), false);
  assert.equal(symlinkEscapes("d/e/l", "../../a.txt"), false);
  assert.equal(symlinkEscapes("l", "../a.txt"), true);
  assert.equal(symlinkEscapes("d/l", "../../a.txt"), true);
  assert.equal(symlinkEscapes("d/l", "x/../../../a"), true);
  assert.equal(symlinkEscapes("l", "/etc/passwd"), true);
  assert.equal(symlinkEscapes("l", "\\\\host\\share"), true);
  assert.equal(symlinkEscapes("l", "C:\\Windows"), true);
  assert.equal(symlinkEscapes("l", "..\\x"), true);
  assert.equal(symlinkEscapes("l", ""), true);
  assert.equal(symlinkEscapes("l", "a\0b"), true);
  assert.equal(symlinkEscapes("d/l", "./x/./y"), false);
});
