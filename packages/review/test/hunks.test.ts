// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyHunks, blobOid, hunkId, parseUnifiedHunks, splitKeepingEol, type Hunk } from "../src/hunks.js";

function parse(patch: string, max = 1000): readonly Hunk[] {
  const r = parseUnifiedHunks(patch, max);
  assert.ok(r.ok, r.ok ? "" : r.reason);
  return r.hunks;
}
const reason = (patch: string, max = 1000): string => {
  const r = parseUnifiedHunks(patch, max);
  return r.ok ? "ok" : r.reason;
};
const all = (hs: readonly Hunk[]): Set<number> => new Set(hs.map((h) => h.index));

const OLD = "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n";
const TWO_HUNKS = "diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n 1\n-2\n+TWO\n 3\n@@ -10,3 +10,3 @@\n 10\n-11\n+ELEVEN\n 12\n";

test("hunks are parsed from the counts in their headers and can be applied one by one", () => {
  const hs = parse(TWO_HUNKS);
  assert.equal(hs.length, 2);
  assert.equal(applyHunks(OLD, hs, new Set([0])), OLD.replace("2\n", "TWO\n"));
  assert.equal(applyHunks(OLD, hs, new Set([1])), OLD.replace("11\n", "ELEVEN\n"));
  assert.equal(applyHunks(OLD, hs, all(hs)), OLD.replace("2\n", "TWO\n").replace("11\n", "ELEVEN\n"));
  assert.equal(applyHunks(OLD, hs, new Set()), OLD);
});

test("a hunk id changes with the hunk's content and is stable for the same content", () => {
  const a = parse(TWO_HUNKS);
  const b = parse(TWO_HUNKS);
  const c = parse(TWO_HUNKS.replace("+TWO", "+TW0"));
  assert.equal(hunkId(a[0] as Hunk), hunkId(b[0] as Hunk));
  assert.notEqual(hunkId(a[0] as Hunk), hunkId(c[0] as Hunk));
  assert.notEqual(hunkId(a[0] as Hunk), hunkId(a[1] as Hunk));
});

test("a header that claims MORE lines than the body has is malformed", () => {
  assert.equal(reason("@@ -1,5 +1,5 @@\n 1\n-2\n+X\n 3\n"), "malformed");
  assert.equal(reason("@@ -1,3 +1,3 @@\n 1\n-2\n+X\n 3\n@@ -9,1 +9,1 @@\n-9\n+Y\n"), "ok");
});

test("a header that claims FEWER lines than the body has is malformed", () => {
  assert.equal(reason("@@ -1,2 +1,2 @@\n 1\n-2\n+X\n 3\n"), "malformed");
  assert.equal(reason("@@ -1,1 +1,1 @@\n-1\n+X\n+EXTRA\n"), "malformed");
});

test("a count that lies in either direction is never believed over the body", () => {
  assert.equal(reason("@@ -1,3 +1,1 @@\n 1\n-2\n+X\n 3\n"), "malformed");
  assert.equal(reason("@@ -1 +1,2 @@\n-1\n+a\n"), "malformed");
  assert.equal(reason("@@ -0,0 +0,0 @@\n"), "malformed");
});

test("a blank line, a stray line or an unknown prefix inside a hunk is malformed", () => {
  assert.equal(reason("@@ -1,2 +1,2 @@\n 1\n\n"), "malformed");
  assert.equal(reason("@@ -1,2 +1,2 @@\n 1\n?2\n"), "malformed");
  assert.equal(reason("@@ -1,1 +1,1 @@\n-1\n+2\ntrailing garbage\n"), "malformed");
  assert.equal(reason("@@ -1,1 +1,1 @@\n-1\n+2\n"), "ok");
});

test("a second file in the patch, a cut-off patch and a bad header are refused", () => {
  assert.equal(reason("@@ -1 +1 @@\n-1\n+2\ndiff --git a/y b/y\n@@ -1 +1 @@\n-1\n+2\n"), "malformed");
  assert.equal(reason("@@ -1 +1 @@\n-1\n+2"), "malformed");
  assert.equal(reason("@@ -1 +1\n-1\n+2\n"), "malformed");
  assert.equal(reason("@@ -12345678901 +1 @@\n-1\n+2\n"), "malformed");
  assert.equal(reason("@@ -a +1 @@\n-1\n+2\n"), "malformed");
});

test("binary patches are recognised, and a patch with no hunks is an empty list", () => {
  assert.equal(reason("diff --git a/x b/x\nBinary files a/x and b/x differ\n"), "binary");
  assert.equal(reason("GIT binary patch\nliteral 3\n"), "binary");
  assert.deepEqual(parse("diff --git a/x b/x\nold mode 100644\nnew mode 100755\n"), []);
});

test("a patch with more hunks than allowed is refused before they are all held", () => {
  const many = Array.from({ length: 50 }, (_, i) => `@@ -${i * 4 + 1} +${i * 4 + 1} @@\n-a\n+b\n`).join("");
  assert.equal(reason(many, 49), "too_many_hunks");
  assert.equal(reason(many, 50), "ok");
});

test("CRLF lines keep their carriage return through parse and apply", () => {
  const old = "a\r\nb\r\nc\r\n";
  const patch = "@@ -1,3 +1,3 @@\n a\r\n-b\r\n+B\r\n c\r\n";
  const hs = parse(patch);
  assert.equal(hs[0]?.lines[1]?.text, "b\r");
  assert.equal(applyHunks(old, hs, all(hs)), "a\r\nB\r\nc\r\n");
});

test("a context line that differs only by a CR does not apply", () => {
  const hs = parse("@@ -1,2 +1,2 @@\n a\n-b\n+B\n");
  assert.equal(applyHunks("a\r\nb\r\n", hs, all(hs)), null);
});

test("no newline at end of file, on the old side, the new side and both", () => {
  const oldSide = parse("@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+b\n");
  assert.equal(applyHunks("a\nb", oldSide, all(oldSide)), "a\nb\n");
  const newSide = parse("@@ -1,2 +1,2 @@\n a\n-b\n+b\n\\ No newline at end of file\n");
  assert.equal(applyHunks("a\nb\n", newSide, all(newSide)), "a\nb");
  const both = parse("@@ -1,2 +1,2 @@\n-a\n+A\n b\n\\ No newline at end of file\n");
  assert.equal(applyHunks("a\nb", both, all(both)), "A\nb");
  assert.equal(applyHunks("a\nb\n", both, all(both)), null, "the old file does end with a newline, so the hunk does not apply");
  const appended = parse("@@ -1,2 +1,3 @@\n a\n-b\n\\ No newline at end of file\n+b\n+c\n");
  assert.equal(applyHunks("a\nb", appended, all(appended)), "a\nb\nc\n");
});

test("U+2028, U+2029 and U+0085 are not line breaks", () => {
  const hs = parse("@@ -1,1 +1,1 @@\n-a\u2028b\u0085c\n+X\n");
  assert.equal(applyHunks("a\u2028b\u0085c\n", hs, all(hs)), "X\n");
  assert.deepEqual(splitKeepingEol("a\u2028b\nc"), ["a\u2028b\n", "c"]);
});

test("a hunk that does not match the old text, overlaps another or is out of range makes apply refuse", () => {
  const hs = parse(TWO_HUNKS);
  assert.equal(applyHunks(OLD.replace("2\n", "two\n"), hs, new Set([0])), null);
  assert.equal(applyHunks("1\n2\n", hs, new Set([0])), null, "the second hunk lies beyond the end of the file");
  const overlap = parse("@@ -1,3 +1,3 @@\n 1\n-2\n+X\n 3\n@@ -3,2 +3,2 @@\n 3\n-4\n+Y\n");
  assert.equal(applyHunks(OLD, overlap, all(overlap)), null);
  const reversed = parse("@@ -10,3 +10,3 @@\n 10\n-11\n+Y\n 12\n@@ -1,3 +1,3 @@\n 1\n-2\n+X\n 3\n");
  assert.equal(applyHunks(OLD, reversed, all(reversed)), null);
});

test("pure insertions and deletions use the line before or after, as git writes them", () => {
  const ins = parse("@@ -2,0 +3,2 @@\n+a\n+b\n");
  assert.equal(applyHunks("1\n2\n3\n", ins, all(ins)), "1\n2\na\nb\n3\n");
  const atStart = parse("@@ -0,0 +1 @@\n+first\n");
  assert.equal(applyHunks("1\n", atStart, all(atStart)), "first\n1\n");
  const del = parse("@@ -2,2 +1,0 @@\n-2\n-3\n");
  assert.equal(applyHunks("1\n2\n3\n4\n", del, all(del)), "1\n4\n");
});

test("splitKeepingEol and blobOid", () => {
  assert.deepEqual(splitKeepingEol(""), []);
  assert.deepEqual(splitKeepingEol("a"), ["a"]);
  assert.deepEqual(splitKeepingEol("a\n\n"), ["a\n", "\n"]);
  assert.equal(blobOid("hello\n", 40), "ce013625030ba8dba906f756967f9e9ca394464a");
  assert.equal(blobOid("", 40), "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
  assert.equal(blobOid("hello\n", 64).length, 64);
});

test("a giant hunk list parses in linear time and memory proportional to the patch", () => {
  const n = 200_000;
  const body = Array.from({ length: n }, (_, i) => `-${i}\n`).join("");
  const t = Date.now();
  const r = parseUnifiedHunks(`@@ -1,${n} +0,0 @@\n${body}`, 10);
  assert.ok(r.ok);
  assert.ok(Date.now() - t < 5000);
});
