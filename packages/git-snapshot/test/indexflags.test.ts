// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { judgeDrift, takeSnapshot, type TakeOptions } from "../src/index.js";
import { resolveGit } from "../src/git.js";
import { git, makeFixture, type Fixture } from "./helpers.js";

const posix = process.platform !== "win32";
const opts = (f: Fixture, more: Partial<TakeOptions> = {}): TakeOptions => ({ worktreePath: f.wt, commonDir: f.common, homeDir: f.home, ...more });

function track(f: Fixture, ...files: string[]): void {
  for (const p of files) {
    mkdirSync(join(f.wt, p, ".."), { recursive: true });
    writeFileSync(join(f.wt, p), "{}\n");
  }
  git(f.wt, "add", ...files);
  git(f.wt, "commit", "-q", "-m", "files");
}

test("skip-worktree on a tracked protected file is in the snapshot, and setting it is drift", { skip: !posix }, async () => {
  const f = makeFixture();
  try {
    track(f, ".alpha/settings.json", "src/plain.ts");
    const before = await takeSnapshot(opts(f));
    assert.equal(before.incomplete.length, 0, JSON.stringify(before.incomplete));
    git(f.wt, "update-index", "--skip-worktree", ".alpha/settings.json");
    const after = await takeSnapshot(opts(f));
    const flag = after.settings.find((s) => s.label === "index flag hides changes" && s.key.includes(".alpha/settings.json"));
    assert.ok(flag, JSON.stringify(after.settings));
    assert.equal(flag.value, "skip-worktree");
    assert.equal(flag.severity, "high");
    assert.equal(judgeDrift({ baseline: before, current: after }).status, "unacknowledged");
    assert.equal(judgeDrift({ baseline: after, current: after }).status, "clean");
  } finally {
    f.cleanup();
  }
});

test("assume-unchanged is read too, and unprotected paths are counted, not listed", { skip: !posix }, async () => {
  const f = makeFixture();
  try {
    track(f, ".alpha/settings.json", "src/plain.ts", "src/other.ts");
    const before = await takeSnapshot(opts(f));
    git(f.wt, "update-index", "--assume-unchanged", ".alpha/settings.json");
    git(f.wt, "update-index", "--skip-worktree", "src/plain.ts", "src/other.ts");
    const after = await takeSnapshot(opts(f));
    const listed = after.settings.filter((s) => s.label === "index flag hides changes");
    assert.equal(listed.find((s) => s.key.includes(".alpha/settings.json"))?.value, "assume-unchanged");
    assert.equal(listed.find((s) => s.key === "index.flagged-count")?.value, "2");
    assert.ok(!listed.some((s) => s.key.includes("src/plain.ts")), "an unprotected path is only counted");
    assert.equal(judgeDrift({ baseline: before, current: after }).status, "unacknowledged");
  } finally {
    f.cleanup();
  }
});

test("a repository with no flagged file has no index setting", { skip: !posix }, async () => {
  const f = makeFixture();
  try {
    track(f, "src/plain.ts");
    const s = await takeSnapshot(opts(f));
    assert.ok(!s.settings.some((x) => x.label === "index flag hides changes"));
  } finally {
    f.cleanup();
  }
});

test("when git cannot list the index flags the snapshot is blocking-incomplete, never clean", { skip: !posix }, async () => {
  const f = makeFixture();
  try {
    const real = resolveGit(process.env["PATH"], []) as string;
    const dir = join(f.root, "bin");
    mkdirSync(dir);
    writeFileSync(join(dir, "git"), `#!/bin/sh\ncase "$*" in *ls-files*) exit 3;; esac\nexec '${real}' "$@"\n`);
    chmodSync(join(dir, "git"), 0o755);
    const s = await takeSnapshot(opts(f, { gitPath: join(dir, "git") }));
    assert.ok(s.incomplete.some((i) => i.id === "index" && i.blocking), JSON.stringify(s.incomplete));
    assert.equal(judgeDrift({ baseline: s, current: s }).status, "refused");
  } finally {
    f.cleanup();
  }
});
