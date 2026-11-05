// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { diffSnapshots, judgeDrift, parseSnapshot, takeSnapshot, type TakeOptions } from "../src/index.js";
import { resolveGit } from "../src/git.js";
import { CRITICAL_LABELS } from "../src/settings.js";
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

test("moving a flag from one unprotected file to another is drift, though the count stays 1", { skip: !posix }, async () => {
  const f = makeFixture();
  try {
    track(f, "src/main.ts", "src/other.ts");
    git(f.wt, "update-index", "--skip-worktree", "src/other.ts");
    const before = await takeSnapshot(opts(f));
    // A run edits main.ts, clears the flag on the other file and sets it on the edited one: status and diff show nothing.
    git(f.wt, "update-index", "--no-skip-worktree", "src/other.ts");
    writeFileSync(join(f.wt, "src", "main.ts"), "edited by a run\n");
    git(f.wt, "update-index", "--skip-worktree", "src/main.ts");
    assert.equal(git(f.wt, "status", "--porcelain").trim(), "", "the edit is hidden from status");
    const after = await takeSnapshot(opts(f));
    assert.equal(before.settings.find((s) => s.key === "index.flagged-count")?.value, "1");
    assert.equal(after.settings.find((s) => s.key === "index.flagged-count")?.value, "1");
    assert.equal(judgeDrift({ baseline: before, current: after }).status, "unacknowledged");
  } finally {
    f.cleanup();
  }
});

test("editing a file that is already flagged changes the digest", { skip: !posix }, async () => {
  const f = makeFixture();
  try {
    track(f, "src/main.ts");
    git(f.wt, "update-index", "--skip-worktree", "src/main.ts");
    const before = await takeSnapshot(opts(f));
    writeFileSync(join(f.wt, "src", "main.ts"), "an edit that changes the size\n");
    const after = await takeSnapshot(opts(f));
    assert.equal(judgeDrift({ baseline: before, current: after }).status, "unacknowledged");
  } finally {
    f.cleanup();
  }
});

test("a file with both flags is flagged (git lists it as assume-unchanged), and the flag is a critical flag in the diff", { skip: !posix }, async () => {
  const f = makeFixture();
  try {
    track(f, ".alpha/a.json");
    const before = await takeSnapshot(opts(f));
    git(f.wt, "update-index", "--skip-worktree", "--assume-unchanged", ".alpha/a.json");
    const after = await takeSnapshot(opts(f));
    assert.equal(after.settings.find((s) => s.key.includes(".alpha/a.json"))?.value, "assume-unchanged");
    const d = diffSnapshots(before, after);
    assert.ok(d.flags.some((x) => /index flag hides changes/.test(x)), JSON.stringify(d.flags));
    assert.equal(d.blocking, true);
  } finally {
    f.cleanup();
  }
});

test("thousands of flagged files: the entry text is bounded and a saved snapshot still loads", { skip: !posix }, async () => {
  const f = makeFixture();
  try {
    const files: string[] = [];
    for (let i = 0; i < 3000; i++) files.push(`pkg${i}/package.json`);
    track(f, ...files);
    git(f.wt, "update-index", "--skip-worktree", ...files);
    const s = await takeSnapshot(opts(f, { limits: { maxSettings: 4000 } }));
    const entry = s.entries.find((e) => e.id === "index/flags");
    assert.ok(entry !== undefined && entry.text !== null && entry.text.length < 20_000, `text ${entry?.text?.length}`);
    assert.equal(entry.textTruncated, true);
    assert.match(entry.text, /^3000 flagged\n/);
    const round = parseSnapshot(JSON.parse(JSON.stringify(s)));
    assert.equal(round.digest, s.digest);
  } finally {
    f.cleanup();
  }
});

test("a listing over the byte limit blocks, it is not scanned to the end", { skip: !posix }, async () => {
  const f = makeFixture();
  try {
    const files = ["a.txt", "b.txt", "c.txt", "d.txt"];
    track(f, ...files);
    const s = await takeSnapshot(opts(f, { limits: { maxIndexBytes: 10 } }));
    assert.ok(s.incomplete.some((i) => i.id === "index" && i.blocking && /too large/.test(i.reason)), JSON.stringify(s.incomplete));
  } finally {
    f.cleanup();
  }
});

test("moving a flag among files that are past the shown text still changes the digest", { skip: !posix }, async () => {
  const f = makeFixture();
  try {
    const many: string[] = [];
    for (let i = 0; i < 1500; i++) many.push(`src/m${i}.ts`);
    track(f, ...many, "zz/one.ts", "zz/two.ts");
    git(f.wt, "update-index", "--skip-worktree", ...many, "zz/one.ts");
    const before = await takeSnapshot(opts(f));
    const entry = before.entries.find((e) => e.id === "index/flags");
    assert.equal(entry?.textTruncated, true);
    assert.ok(!entry.text?.includes("zz/one.ts"), "the file is past the shown text");
    git(f.wt, "update-index", "--no-skip-worktree", "zz/one.ts");
    git(f.wt, "update-index", "--skip-worktree", "zz/two.ts");
    const after = await takeSnapshot(opts(f));
    assert.equal(after.settings.find((s) => s.key === "index.flagged-count")?.value, before.settings.find((s) => s.key === "index.flagged-count")?.value);
    assert.equal(after.entries.find((e) => e.id === "index/flags")?.text, entry.text, "the shown text is the same");
    assert.equal(judgeDrift({ baseline: before, current: after }).status, "unacknowledged");
  } finally {
    f.cleanup();
  }
});

test("the index flag label is a critical label", () => {
  assert.equal(CRITICAL_LABELS.has("index flag hides changes"), true);
});
