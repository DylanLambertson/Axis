// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The views of axis.review/1.content built from hostile bytes (ticket RV-CONTENT): every result passes the wire schema.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CONTENT_REFUSED, MAX_CONTENT_FILE_CHARS, MAX_CONTENT_LINE, MAX_CONTENT_LINES, MAX_CONTENT_TEXT_BYTES, contentViewSchema, type ContentView } from "@axis/protocol";
import { escapeBytes, fileView, linkView, looksBinary } from "../src/handlers/review-content-view.js";

const OID = "0123456789abcdef0123456789abcdef01234567";
const B = (s: string | readonly number[]): Uint8Array => (typeof s === "string" ? new Uint8Array(Buffer.from(s, "utf8")) : Uint8Array.from(s));
const esc = (s: string | readonly number[], max = MAX_CONTENT_LINE): string => {
  const b = B(s);
  return escapeBytes(b, 0, b.length, max).text;
};
const W = (bytes: Uint8Array): { bytes: Uint8Array; complete: boolean } => ({ bytes, complete: true });
function view(bytes: Uint8Array, opts: { size?: number; complete?: boolean; budget?: number } = {}): ContentView {
  const v = fileView({ size: opts.size ?? bytes.length, bytes, complete: opts.complete ?? true }, OID, opts.budget ?? MAX_CONTENT_FILE_CHARS);
  assert.equal(contentViewSchema.safeParse(v).success, true, `the view passes the wire schema: ${JSON.stringify(v).slice(0, 200)}`);
  return v;
}
const textOf = (v: ContentView): { first: string[]; last: string[] } => {
  assert.ok(v.kind === "text" || v.kind === "too-large", v.kind);
  return { first: v.first, last: v.last };
};

test("terminal sequences, controls, bidi and zero-width characters are made visible, a backslash is doubled, a tab is kept", () => {
  assert.equal(esc("\u001b[31mred\u001b[0m"), "\\u{1b}[31mred\\u{1b}[0m");
  assert.equal(esc("\u001b]8;;https://evil.example\u0007click\u001b]8;;\u001b\\"), "\\u{1b}]8;;https://evil.example\\u{7}click\\u{1b}]8;;\\u{1b}\\\\");
  assert.equal(esc("a\u202eb\u2066c\u200bd\u200de\ufefff\u00adg"), "a\\u{202e}b\\u{2066}c\\u{200b}d\\u{200d}e\\u{feff}f\\u{ad}g");
  assert.equal(esc("\u0085\u009b\u007f\u2028\u{e0041}\ufe0f\u3164"), "\\u{85}\\u{9b}\\u{7f}\\u{2028}\\u{e0041}\\u{fe0f}\\u{3164}");
  assert.equal(esc("\tx\\u{1b}"), "\tx\\\\u{1b}", "a literal escape in the file cannot pass as one made by the host");
  assert.equal(esc("caf\u00e9 \u4e2d \u{1f600}"), "caf\u00e9 \u4e2d \u{1f600}");
  for (const s of ["\u001b[2J", "\u0000\u0001\u0002", "\r", "\u202e\u2067\u200e", "\u{e0001}"]) assert.equal(CONTENT_REFUSED.test(esc(s)), false, JSON.stringify(s));
});

test("bytes that are not valid UTF-8 are shown as \\xhh, never as U+FFFD and never decoded leniently", () => {
  assert.equal(esc([0x61, 0xff, 0x62]), "a\\xffb");
  assert.equal(esc([0xc0, 0x80]), "\\xc0\\x80", "an overlong NUL");
  assert.equal(esc([0xe0, 0x80, 0xaf]), "\\xe0\\x80\\xaf", "an overlong slash");
  assert.equal(esc([0xed, 0xa0, 0x80]), "\\xed\\xa0\\x80", "an encoded surrogate");
  assert.equal(esc([0xf4, 0x90, 0x80, 0x80]), "\\xf4\\x90\\x80\\x80", "above U+10FFFF");
  assert.equal(esc([0xf5, 0x41]), "\\xf5A");
  assert.equal(esc([0xe2, 0x82]), "\\xe2\\x82", "a sequence cut by the end");
  assert.equal(esc([0xe2, 0x82, 0x41]), "\\xe2\\x82A", "a sequence cut by an ASCII byte");
  assert.equal(esc([0xe2, 0x80, 0xae]), "\\u{202e}", "a valid RLO is still escaped");
  assert.equal(esc([0xef, 0xbf, 0xbd]), "\ufffd", "a real U+FFFD in the file is just text");
});

test("a long line is cut at the bound, on a token, with the work bounded by the bound", () => {
  const huge = B("x".repeat(5_000_000));
  const r = escapeBytes(huge, 0, huge.length, MAX_CONTENT_LINE);
  assert.deepEqual([r.text.length, r.cut], [MAX_CONTENT_LINE, true]);
  const escapes = escapeBytes(B("\u001b".repeat(200)), 0, 200, 20);
  assert.deepEqual([escapes.text, escapes.cut], ["\\u{1b}\\u{1b}\\u{1b}", true], "an escape is never split");
  const v = view(B(`${"y".repeat(10_000)}\nshort\n`));
  assert.ok(v.kind === "text");
  assert.deepEqual([v.first[0]?.length, v.first[1], v.cutLines, v.omittedLines, v.lines], [MAX_CONTENT_LINE, "short", 1, 0, 2]);
});

test("NUL in the leading bytes makes a binary marker with no bytes; later, it is a visible escape in text", () => {
  const bin = view(B([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
  assert.deepEqual(bin, { kind: "binary", size: 6, objectPrefix: OID.slice(0, 12) });
  const late = B([...Buffer.from(`${"a".repeat(8100)}\n`), 0x78, 0x00, 0x79, 0x0a]);
  assert.equal(looksBinary(late), false);
  const v = view(late);
  assert.ok(v.kind === "text");
  assert.equal(v.first[1], "x\\u{0}y");
  // A text file over the text bound that has a NUL in its head is binary too: the size never decides alone.
  const big = new Uint8Array(MAX_CONTENT_TEXT_BYTES + 10).fill(0x61);
  big[1] = 0;
  assert.equal(view(big).kind, "binary");
});

test("lines split on LF only: a CR is shown, a final newline is reported, an empty file has no lines", () => {
  const v = view(B("a\r\nb\r\n"));
  assert.deepEqual(v, { kind: "text", size: 6, lines: 2, first: ["a\\u{d}", "b\\u{d}"], last: [], omittedLines: 0, cutLines: 0, finalNewline: true });
  const n = view(B("one\ntwo"));
  assert.ok(n.kind === "text");
  assert.deepEqual([n.first, n.lines, n.finalNewline], [["one", "two"], 2, false]);
  assert.deepEqual(view(new Uint8Array(0)), { kind: "text", size: 0, lines: 0, first: [], last: [], omittedLines: 0, cutLines: 0, finalNewline: false });
  const blanks = view(B("\n\n\n"));
  assert.ok(blanks.kind === "text");
  assert.deepEqual([blanks.first, blanks.lines], [["", "", ""], 3]);
});

test("many lines: the first and last lines are shown with the gap counted, and nothing is shown twice", () => {
  const body = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join("\n");
  const v = view(B(`${body}\n`));
  assert.ok(v.kind === "text");
  const half = MAX_CONTENT_LINES / 2;
  assert.deepEqual([v.first.length, v.last.length, v.omittedLines, v.lines], [half, half, 1000 - MAX_CONTENT_LINES, 1000]);
  assert.deepEqual([v.first[0], v.first[half - 1], v.last[0], v.last[half - 1]], ["line 0", `line ${half - 1}`, `line ${1000 - half}`, "line 999"]);
  // Just over the line bound: no line shown twice, the gap is what is left.
  const few = view(B(Array.from({ length: MAX_CONTENT_LINES + 1 }, (_, i) => `${i}`).join("\n")));
  assert.ok(few.kind === "text");
  assert.equal(few.first.length + few.last.length + few.omittedLines, MAX_CONTENT_LINES + 1);
  assert.equal(new Set([...few.first, ...few.last]).size, few.first.length + few.last.length);
});

test("the text budget binds a file and a reply: a small budget shows less, a zero budget shows nothing and counts it", () => {
  const body = B(Array.from({ length: 100 }, () => "z".repeat(500)).join("\n"));
  const full = textOf(view(body));
  assert.ok(full.first.join("").length + full.last.join("").length <= MAX_CONTENT_FILE_CHARS);
  const small = view(body, { budget: 2000 });
  assert.ok(small.kind === "text");
  assert.ok(small.first.join("").length + small.last.join("").length <= 2000);
  assert.ok(small.omittedLines > 0);
  const none = view(body, { budget: 0 });
  assert.ok(none.kind === "text");
  assert.deepEqual([none.first, none.last, none.omittedLines], [[], [], 100]);
});

test("over the text bound: a first and a last excerpt, and only the first when the read stopped early", () => {
  const line = "0123456789,abcdefghij\n";
  const big = B(line.repeat(Math.ceil((MAX_CONTENT_TEXT_BYTES + 1) / line.length)));
  const whole = view(big);
  assert.ok(whole.kind === "too-large");
  assert.deepEqual([whole.readComplete, whole.first.length, whole.last.length, whole.objectPrefix], [true, MAX_CONTENT_LINES / 2, MAX_CONTENT_LINES / 2, OID.slice(0, 12)]);
  const prefix = big.subarray(0, 50_000 + 5);
  const cut = view(prefix, { size: big.length, complete: false });
  assert.ok(cut.kind === "too-large");
  assert.deepEqual([cut.readComplete, cut.last, cut.first.length], [false, [], MAX_CONTENT_LINES / 2]);
  assert.ok(cut.first.every((l) => l === line.slice(0, -1)), "the unfinished last line of a prefix is never shown");
  assert.throws(() => fileView({ size: 10, bytes: B("abc"), complete: false }, OID, 100), RangeError, "a small file that did not read whole is a fault");
});

test("a prefix whose finished lines all fit also shows its unfinished line, cut and counted", () => {
  const size = MAX_CONTENT_TEXT_BYTES + 10;
  const oneLine = view(B("x".repeat(4000)), { size, complete: false });
  assert.ok(oneLine.kind === "too-large");
  assert.deepEqual([oneLine.first, oneLine.last, oneLine.cutLines], [["x".repeat(MAX_CONTENT_LINE)], [], 1], "minified code shows something");
  const some = view(B("a\nb\nccc"), { size, complete: false });
  assert.ok(some.kind === "too-large");
  assert.deepEqual([some.first, some.cutLines], [["a", "b", "ccc"], 1], "the unfinished line counts as cut even when short");
  const ends = view(B("a\nb\n"), { size, complete: false });
  assert.ok(ends.kind === "too-large");
  assert.deepEqual([ends.first, ends.cutLines], [["a", "b"], 0], "a prefix ending at a newline has no unfinished line");
  const tight = view(B("ab\n" + "y".repeat(100)), { size, complete: false, budget: 10 });
  assert.ok(tight.kind === "too-large");
  assert.deepEqual([tight.first, tight.cutLines], [["ab"], 0], "not shown when it would pass the budget");
  for (const v of [oneLine, some, ends, tight]) assert.equal(contentViewSchema.safeParse(v).success, true);
});

test("a combining mark is escaped at the start of a line and kept after a base character", () => {
  assert.equal(escapeBytes(B("\u0336a\u0336"), 0, 5, 100).text, "\\u{336}a\u0336");
  assert.equal(escapeBytes(B("\u20e3"), 0, 3, 100).text, "\\u{20e3}");
  assert.equal(contentViewSchema.safeParse({ kind: "symlink", target: "\u0336x", targetCut: false, escapesWorktree: false }).success, false);
});

test("a link view shows the escaped target and its flags, bounded", () => {
  assert.deepEqual(linkView(W(B("../\u202e/etc")), true, 1000), { kind: "symlink", target: "../\\u{202e}/etc", targetCut: false, escapesWorktree: true });
  const long = linkView(W(B("a/".repeat(2000))), false, 1000);
  assert.deepEqual([long.kind === "symlink" && long.target.length, long.kind === "symlink" && long.targetCut], [MAX_CONTENT_LINE, true]);
  const tight = linkView(W(B("abcdef")), false, 3);
  assert.deepEqual(tight, { kind: "symlink", target: "abc", targetCut: true, escapesWorktree: false });
  const prefix = linkView({ bytes: B("ab"), complete: false }, true, 1000);
  assert.deepEqual(prefix, { kind: "symlink", target: "ab", targetCut: true, escapesWorktree: true }, "a target read as a prefix is cut");
  for (const v of [long, tight, prefix]) assert.equal(contentViewSchema.safeParse(v).success, true);
});
