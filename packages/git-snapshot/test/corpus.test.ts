// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseGitConfig } from "../src/index.js";
import { parseListOutput } from "../src/git.js";

const b = (...parts: (string | number[])[]): Buffer =>
  Buffer.concat(parts.map((p) => (typeof p === "string" ? Buffer.from(p, "latin1") : Buffer.from(p))));

// Hostile and odd configs, as bytes. `known` marks a case where this parser is allowed to differ from git, and why.
interface Case {
  readonly name: string;
  readonly text: Buffer;
  readonly known?: string;
}

const NUL_VALUE = "git truncates a value at a NUL byte; the parser keeps it, which later resolves to nothing and fails closed";
const BARE_FIRST = "git lists a key before any section as a bare key that it never uses; the parser drops it";

const cases: Case[] = [
  { name: "plain", text: b("[core]\n\thooksPath = .husky\n") },
  { name: "mixed case section and key", text: b("[CoRe]\n\tHooksPATH = x\n") },
  { name: "subsection with quotes and backslash", text: b('[remote "a\\"b\\\\c"]\n\turl = u\n') },
  { name: "legacy subsection", text: b("[Remote.Origin]\n\turl = u\n") },
  { name: "dotted section with quoted subsection", text: b('[a.b "C"]\n\tk = v\n') },
  { name: "key on the header line", text: b("[core] hooksPath = x\n") },
  { name: "crlf", text: b("[core]\r\n\thooksPath = x\r\n") },
  { name: "lone cr inside a value", text: b("[core]\n\thooksPath = a\rb\n") },
  { name: "bom", text: b([0xef, 0xbb, 0xbf], "[core]\n\thooksPath = x\n") },
  { name: "continuation outside quotes", text: b("[core]\n\thooksPath = a\\\nb\n") },
  { name: "continuation inside quotes", text: b('[core]\n\thooksPath = "a\\\nb"\n') },
  { name: "comment markers inside quotes", text: b('[core]\n\thooksPath = "a;b#c" ; real comment\n') },
  { name: "internal tabs and spaces", text: b("[core]\n\thooksPath = a \t b\n") },
  { name: "trailing spaces trimmed", text: b("[core]\n\thooksPath = x   \n") },
  { name: "quoted trailing spaces kept", text: b('[core]\n\thooksPath = "x  "\n') },
  { name: "adjacent quoted parts", text: b('[core]\n\thooksPath = a" "b\n') },
  { name: "escapes", text: b('[alias]\n\tx = "a\\nb\\tc\\bd\\"e\\\\f"\n') },
  { name: "bare key", text: b("[core]\n\tbare\n") },
  { name: "empty value", text: b("[core]\n\thooksPath =\n") },
  { name: "empty quoted value", text: b('[core]\n\thooksPath = ""\n') },
  { name: "repeated keys", text: b("[core]\n\ta = 1\n\ta = 2\n") },
  { name: "comment lines and blanks", text: b("# c\n; c\n\n[core]\n# c\n\tx = 1\n") },
  { name: "form feed kept in a value", text: b("[core]\n\thooksPath = /x\f\n") },
  { name: "vertical tab kept in a value", text: b("[core]\n\thooksPath = \v/x\n") },
  { name: "invalid utf-8 value", text: b("[core]\n\thooksPath = h", [0xff], "\n") },
  { name: "invalid utf-8 subsection", text: b('[remote "', [0xff], '"]\n\turl = u\n') },
  { name: "backslash at end of file", text: b("[include]\n\tpath = /x\\") },
  { name: "backslash before the final newline", text: b("[include]\n\tpath = /x\\\n") },
  { name: "no final newline", text: b("[core]\n\thooksPath = x") },
  { name: "value with equals signs", text: b("[a]\n\tk = x=y=z\n") },
  { name: "long value", text: b("[a]\n\tk = ", "x".repeat(100_000), "\n") },
  { name: "many sections", text: b(Array.from({ length: 200 }, (_, i) => `[s${i}]\n\tk = ${i}\n`).join("")) },
  { name: "section names with digits and dashes", text: b("[a-1b]\n\tk-2 = v\n") },
  { name: "unicode subsection", text: b('[url "https://example.invalid/\u00e9"]\n\tinsteadOf = x\n') },
  { name: "reject: unterminated quote", text: b('[a]\n\tk = "x\n') },
  { name: "reject: bad escape", text: b("[a]\n\tk = \\q\n") },
  { name: "reject: unterminated header", text: b("[a\n\tk = v\n") },
  { name: "reject: space in section name", text: b("[a b]\n\tk = v\n") },
  { name: "reject: key with a space then text", text: b("[a]\n\tk x = v\n") },
  { name: "reject: digit-first key", text: b("[a]\n\t1k = v\n") },
  { name: "reject: junk line", text: b("[a]\n\t=v\n") },
  { name: "nul inside a value", text: b("[a]\n\tk = x", [0], "y\n"), known: NUL_VALUE },
  { name: "key before any section", text: b("k = v\n[a]\n\tj = 1\n"), known: BARE_FIRST },
];

test("the parser agrees with git on a corpus of hostile configs, or errs on the cautious side", () => {
  assert.ok(cases.length >= 40, `corpus has ${cases.length} cases`);
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "axis-corpus-")));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("GIT_")) env[k] = v;
  let same = 0;
  let rejected = 0;
  const different: string[] = [];
  try {
    for (const [i, c] of cases.entries()) {
      const file = join(dir, `c${i}`);
      writeFileSync(file, c.text);
      let out: Buffer | null = null;
      try {
        out = execFileSync("git", ["config", "--file", file, "--list", "-z"], { env, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
      } catch {
        out = null;
      }
      const mine = parseGitConfig(c.text.toString("latin1"), 1_000_000);
      if (out === null) {
        // git refuses the file outright, so no git command works with it. The parser must not call it clean.
        rejected++;
        assert.ok(mine.errors > 0, `${c.name}: git rejects it and the parser reports no error`);
        continue;
      }
      const wrapped = parseListOutput(Buffer.concat(splitRecords(out).map((r) => Buffer.concat([Buffer.from("file:x\0"), r]))));
      assert.ok(wrapped !== null, c.name);
      const theirs = (wrapped as { key: string; value: string | null }[]).map((e) => [e.key, e.value]);
      const ours = mine.entries.map((e) => [`${e.section}${e.subsection === null ? "" : `.${e.subsection}`}.${e.name}`, e.value]);
      if (JSON.stringify(theirs) === JSON.stringify(ours) && mine.errors === 0) {
        same++;
        assert.equal(c.known, undefined, `${c.name} is listed as a known difference but agrees`);
      } else {
        different.push(c.name);
        assert.notEqual(c.known, undefined, `${c.name}: unexplained difference: git ${JSON.stringify(theirs)} parser ${JSON.stringify(ours)} errors ${mine.errors}`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // Every difference is one of the explained ones, and the counts are pinned so a drift in either direction shows.
  assert.deepEqual(different.sort(), cases.filter((c) => c.known !== undefined).map((c) => c.name).sort());
  assert.ok(same >= 25, `agreeing cases: ${same}`);
  assert.ok(rejected >= 6, `rejected by git: ${rejected}`);
});

/** `git config --list -z` without origins is `key LF value NUL` records. */
function splitRecords(out: Buffer): Buffer[] {
  const recs: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < out.length; i++) {
    if (out[i] === 0) {
      recs.push(out.subarray(start, i + 1));
      start = i + 1;
    }
  }
  return recs;
}
