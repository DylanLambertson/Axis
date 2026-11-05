// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PatchReader, unquotePath } from "../src/index.js";
import { canary, patch, randomValue, rnd, rules, scan, assertNoText } from "./helpers.js";

test("a finding carries the new-file line, across hunks and context lines", () => {
  const key = canary.aws(3);
  const text =
    "diff --git a/src/a.ts b/src/a.ts\nindex 1111111..2222222 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n" +
    `@@ -10,3 +10,4 @@ function f() {\n ctx one\n-old\n+new\n ctx two\n+const id = "${key}";\n` +
    `@@ -40,2 +41,3 @@\n ctx\n+${canary.github(2)}\n ctx\n`;
  const fs = scan(text, { commit: "a".repeat(40) });
  assert.deepEqual(fs, [
    { rule: "aws-access-key-id", path: "src/a.ts", line: 13, commit: "a".repeat(40) },
    { rule: "github-token", path: "src/a.ts", line: 42, commit: "a".repeat(40) },
  ]);
  assertNoText(fs, key);
});

test("removed and context lines are not scanned, only added ones", () => {
  const text =
    "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1,2 +1,1 @@\n" + `-id=${canary.aws(1)}\n ${canary.aws(2)}\n+nothing here\n`;
  assert.deepEqual(scan(text), []);
});

test("an added line that looks like a header or a hunk does not change the file or the line count", () => {
  const evil = patch("src/a.ts", ["+++ b/other/path.ts", "@@ -1 +1 @@", `diff --git a/x b/x`, canary.aws(5)]);
  assert.deepEqual(scan(evil), [{ rule: "aws-access-key-id", path: "src/a.ts", line: 4 }]);
});

test("paths: spaces, quoted non-ASCII, renames off, tab suffix and a path under a directory", () => {
  const k = canary.aws(6);
  assert.deepEqual(scan(patch("my dir/a b.txt", [k])), [{ rule: "aws-access-key-id", path: "my dir/a b.txt", line: 1 }]);
  const quoted = `diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"\nnew file mode 100644\n--- /dev/null\n+++ "b/caf\\303\\251.txt"\n@@ -0,0 +1 @@\n+${k}\n`;
  assert.deepEqual(scan(quoted), [{ rule: "aws-access-key-id", path: "café.txt", line: 1 }]);
  assert.equal(unquotePath('"a\\tb\\"c\\\\d"'), 'a\tb"c\\d');
  assert.equal(unquotePath("plain"), "plain");
  const tab = `diff --git a/x y b/x y\n--- a/x y\t\n+++ b/x y\t\n@@ -0,0 +1 @@\n+${k}\n`;
  assert.deepEqual(scan(tab), [{ rule: "aws-access-key-id", path: "x y", line: 1 }]);
});

test("a binary file whose name holds ' b/' is named from the header halves", () => {
  const m = "diff --git a/dir b/x.png b/dir b/x.png\nnew file mode 100644\nindex 0000000..1111111\nBinary files /dev/null and b/dir b/x.png differ\n";
  assert.deepEqual(scan(m), [{ rule: "binary-unscanned", path: "dir b/x.png" }]);
});

test("merge output (-m) of two parents is read as two diffs", () => {
  const a = patch("a.txt", [canary.aws(1)]);
  const b = patch("b.txt", [canary.github(1)]);
  assert.deepEqual(rules(scan(a + b)), ["aws-access-key-id", "github-token"]);
  assert.deepEqual(scan(a + b).map((f) => f.path), ["a.txt", "b.txt"]);
});

test("a diff that is not from git still has its plus lines scanned", () => {
  assert.deepEqual(scan(`+${canary.aws(1)}\n`), [{ rule: "aws-access-key-id" }]);
});

test("commit message part: every line is plain text, with line numbers and no path", () => {
  const msg = `tree 1\nauthor A <a@example.org> 1 +0000\n\nfix: a thing\n\nhttps://ci:${randomValue(4, 20)}@ci.example.org/x\n`;
  assert.deepEqual(scan(msg, { part: "message", commit: "b".repeat(40) }), [{ rule: "url-credentials", line: 6, commit: "b".repeat(40) }]);
  // The same text read as a patch has no added line, so nothing: the part decides.
  assert.deepEqual(scan(msg), []);
});

test("binary files: scanned below the size limit, `binary-unscanned` over it, and for git's own markers", () => {
  const body = [canary.aws(1), ...Array.from({ length: 20 }, (_, i) => rnd(i, 100))];
  assert.deepEqual(rules(scan(patch("a.bin", body), { binaryPaths: ["a.bin"] }, { maxBinaryBytes: 4096 })), ["aws-access-key-id"]);
  // The first line is inside the budget and is scanned; the rest is over it and is reported once, as a file.
  const over = scan(patch("a.bin", body), { binaryPaths: ["a.bin"] }, { maxBinaryBytes: 500 });
  assert.deepEqual(over, [{ rule: "aws-access-key-id", path: "a.bin", line: 1 }, { rule: "binary-unscanned", path: "a.bin" }]);
  const late = scan(patch("a.bin", [...body.slice(1), canary.aws(1)]), { binaryPaths: ["a.bin"] }, { maxBinaryBytes: 500 });
  assert.deepEqual(late, [{ rule: "binary-unscanned", path: "a.bin" }]);
  const marker = "diff --git a/i.png b/i.png\nnew file mode 100644\nindex 0000000..1111111\nBinary files /dev/null and b/i.png differ\n";
  assert.deepEqual(scan(marker), [{ rule: "binary-unscanned", path: "i.png" }]);
  const gp = "diff --git a/i.png b/i.png\nnew file mode 100644\nindex 0000000..1111111\nGIT binary patch\nliteral 12\n+" + canary.aws(9) + "\n\n";
  assert.deepEqual(scan(gp), [{ rule: "binary-unscanned", path: "i.png" }]);
  const gone = "diff --git a/i.png b/i.png\ndeleted file mode 100644\nindex 1111111..0000000\nBinary files a/i.png and /dev/null differ\n";
  assert.deepEqual(scan(gone), []);
});

test("PatchReader: a hunk cut short ends cleanly and later files are still read", () => {
  const r = new PatchReader();
  const evs = [
    "diff --git a/a b/a", "--- a/a", "+++ b/a", "@@ -1,5 +1,5 @@", "+one", "diff --git a/b b/b", "--- a/b", "+++ b/b", "@@ -0,0 +1 @@", "+two",
  ].map((l) => r.read(l));
  const added = evs.filter((e) => e?.t === "added");
  assert.deepEqual(added.map((e) => (e?.t === "added" ? [e.path, e.text] : [])), [["a", "one"], ["b", "two"]]);
});
