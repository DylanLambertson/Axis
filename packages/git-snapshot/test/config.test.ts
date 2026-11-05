// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { diffSnapshots, escapeDisplay, judgeDrift, parseGitConfig } from "../src/index.js";
import { git, makeFixture } from "./helpers.js";

const kv = (s: string) => parseGitConfig(s, 1000).entries.map((e) => [e.section, e.subsection, e.name, e.value]);

test("parser: sections, subsections, quoting, escapes, comments, continuation", () => {
  assert.deepEqual(kv('[Core]\n\tHooksPath = .x ; c\n[remote "Or\\"i\\\\g"]\n url = "a b"  # c\n'), [
    ["core", null, "hookspath", ".x"],
    ["remote", 'Or"i\\g', "url", "a b"],
  ]);
  assert.deepEqual(kv("[alias]\n x = a\\\nb\n y = \"q\\n\\t\"\n bare\n"), [
    ["alias", null, "x", "ab"],
    ["alias", null, "y", "q\n\t"],
    ["alias", null, "bare", null],
  ]);
  // Legacy subsection syntax is lower-cased; an entry after a header on the same line and a BOM are seen.
  assert.deepEqual(kv("\ufeff[Core.Sub] a = 1\n"), [["core", "sub", "a", "1"]]);
  assert.deepEqual(kv("[core]\r\n\thooksPath = x\r\n"), [["core", null, "hookspath", "x"]]);
});

test("parser: newlines and quotes in values stay one value; bad lines are counted, not guessed", () => {
  const p = parseGitConfig('[alias]\n evil = "a\\nb\\"c"\n broken = "unterminated\n ok = 1\n', 1000);
  assert.deepEqual(p.entries.map((e) => [e.name, e.value]), [["evil", 'a\nb"c'], ["ok", "1"]]);
  assert.equal(p.errors, 1);
  assert.equal(parseGitConfig("x = 1\n[core]\n", 10).errors, 1, "a key before any section is an error");
});

test("parser: a hostile 1 MiB line and many entries are linear and capped", () => {
  const t0 = Date.now();
  parseGitConfig(`[a]\n${"k = ".padEnd(1_000_000, "x")}\n`, 10);
  const many = parseGitConfig(`[a]\n${"k = v\n".repeat(200_000)}`, 100);
  assert.equal(many.entries.length, 100);
  assert.equal(many.truncated, true);
  assert.ok(Date.now() - t0 < 3000);
});

test("a quote-and-newline config value reaches git and the diff as one escaped value", async () => {
  const f = makeFixture();
  try {
    const base = await f.snap();
    git(f.wt, "config", "alias.weird", '!echo "a\nb"');
    const cur = await f.snap();
    const d = diffSnapshots(base, cur);
    const s = d.settingChanges.find((x) => x.key === "alias.weird");
    assert.deepEqual(s?.added, ['!echo "a\\u{a}b"']);
    assert.equal(judgeDrift({ baseline: base, current: cur }).status, "unacknowledged");
  } finally {
    f.cleanup();
  }
});

test("no secret reaches the diff, the snapshot text or an error", async () => {
  const f = makeFixture();
  try {
    const tok = "ghp_" + "a".repeat(36);
    const pass = "hunter2hunter2";
    const base = await f.snap();
    git(f.wt, "config", "remote.origin.url", `https://user:${pass}@example.invalid/o/r.git`);
    git(f.wt, "config", "remote.origin.pushurl", `https://${tok}@example.invalid/o/r.git`);
    git(f.wt, "config", `url.https://tokuser:${pass}@example.invalid/.insteadOf`, "https://example.invalid/");
    git(f.wt, "config", "http.extraheader", `Authorization: Bearer ${tok}`);
    git(f.wt, "config", "credential.helper", `!f() { echo password=${pass}; }; f`);
    const hook = join(f.common, "hooks", "pre-push");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(hook, `#!/bin/sh\ncurl -H "Authorization: Bearer ${tok}" https://x.invalid\nexport API_TOKEN=${pass}\n`, { mode: 0o755 });
    const cur = await f.snap();
    const blob = JSON.stringify([diffSnapshots(base, cur), cur]);
    assert.ok(!blob.includes(pass), "password leaked");
    assert.ok(!blob.includes(tok), "token leaked");
    assert.ok(blob.includes("remote.origin.url"), "the setting is still shown");
    // A rotated secret still shows as a change of the file.
    git(f.wt, "config", "remote.origin.url", `https://user:otherpassword99@example.invalid/o/r.git`);
    const rot = await f.snap();
    assert.notEqual(rot.digest, cur.digest);
    assert.ok(!JSON.stringify(diffSnapshots(cur, rot)).includes("otherpassword99"));
  } finally {
    f.cleanup();
  }
});

test("escapeDisplay escapes control, bidi, invisible characters, lone surrogates and backslashes", () => {
  const rlo = String.fromCodePoint(0x202e);
  const zw = String.fromCodePoint(0x200b);
  assert.equal(escapeDisplay(`a${rlo}b${zw}\n\u0007\\`), "a\\u{202e}b\\u{200b}\\u{a}\\u{7}\\\\");
  assert.equal(escapeDisplay("\ud800x"), "\\u{d800}x");
  assert.equal(escapeDisplay("caf\u00e9 \u{1f600}"), "caf\u00e9 \u{1f600}");
});
