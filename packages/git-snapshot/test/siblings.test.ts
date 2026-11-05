// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { judgeDrift, takeSnapshot, type TakeOptions } from "../src/index.js";
import { forgetGit, resolveGit } from "../src/git.js";
import { redactText } from "../src/display.js";
import { git, makeFixture, type Fixture } from "./helpers.js";

const posix = process.platform !== "win32";
const realPath = process.env["PATH"] ?? "";
const opts = (f: Fixture, more: Partial<TakeOptions> = {}): TakeOptions => ({ worktreePath: f.wt, commonDir: f.common, homeDir: f.home, ...more });

const plant = (dir: string, marker: string): string => {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "git");
  writeFileSync(p, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
  chmodSync(p, 0o755);
  return p;
};

/** The bad `gitdir` files an attacker who writes `.git/worktrees` can leave: each must block, quickly, and never hang. */
const shapes: readonly (readonly [string, (p: string) => void])[] = [
  ["a FIFO", (p) => void execFileSync("mkfifo", [p])],
  ["a symlink to /dev/zero", (p) => symlinkSync("/dev/zero", p)],
  ["a symlink to a file", (p) => symlinkSync("/etc/hostname", p)],
  ["a directory", (p) => mkdirSync(p)],
  ["a huge sparse file", (p) => (writeFileSync(p, ""), truncateSync(p, 1.5 * 1024 ** 3))],
  ["a file with no path", (p) => writeFileSync(p, "\n")],
  ["a file with a NUL", (p) => writeFileSync(p, "/a\0/b\n")],
  ["an unreadable file", (p) => (writeFileSync(p, "/x/.git\n"), chmodSync(p, 0))],
];

for (const [name, make] of shapes) {
  test(`sibling list: ${name} in worktrees/*/gitdir blocks, in bounded time`, { skip: !posix || (name === "an unreadable file" && process.getuid?.() === 0) }, async () => {
    const f = makeFixture();
    try {
      mkdirSync(join(f.common, "worktrees", "zz"));
      make(join(f.common, "worktrees", "zz", "gitdir"));
      const t0 = Date.now();
      const s = await takeSnapshot(opts(f));
      assert.ok(Date.now() - t0 < 4000, `took ${Date.now() - t0} ms`);
      assert.ok(s.incomplete.some((i) => i.blocking && i.id === "worktrees/zz/gitdir"), JSON.stringify(s.incomplete));
      assert.equal(judgeDrift({ baseline: s, current: s }).status, "refused");
    } finally {
      f.cleanup();
    }
  });
}

test("sibling list: a FIFO does not outlive an abort", { skip: !posix }, async () => {
  const f = makeFixture();
  try {
    mkdirSync(join(f.common, "worktrees", "zz"));
    execFileSync("mkfifo", [join(f.common, "worktrees", "zz", "gitdir")]);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const t0 = Date.now();
    await takeSnapshot(opts(f, { signal: ac.signal })).catch(() => undefined);
    assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`);
  } finally {
    f.cleanup();
  }
});

test("sibling list: a relative gitdir file (git --relative-paths) still excludes the sibling's git", { skip: !posix }, async () => {
  const f = makeFixture();
  try {
    const sib = join(f.root, "sib");
    git(f.main, "worktree", "add", "-q", "--relative-paths", "-b", "axis/rel", sib);
    const entry = execFileSync("ls", [join(f.common, "worktrees")], { encoding: "utf8" }).split("\n").filter((n) => n !== "" && readFileSync(join(f.common, "worktrees", n, "gitdir"), "utf8").includes("sib"))[0] as string;
    const text = readFileSync(join(f.common, "worktrees", entry, "gitdir"), "utf8");
    assert.ok(!text.startsWith("/"), `git wrote an absolute gitdir (${text.trim()}), so the relative case is not exercised`);
    const marker = join(f.root, "ran");
    const planted = plant(join(sib, "bin"), marker);
    forgetGit();
    const s = await takeSnapshot(opts(f, { env: { PATH: `${join(sib, "bin")}:${realPath}` } }));
    assert.equal(existsSync(marker), false, "the sibling's git ran");
    assert.equal(s.incomplete.length, 0, JSON.stringify(s.incomplete));
    await assert.rejects(takeSnapshot(opts(f, { gitPath: planted })), /outside every worktree/);
  } finally {
    f.cleanup();
  }
});

test("an injected gitPath inside a sibling worktree is refused, with no extraWorktreeRoots", { skip: !posix }, async () => {
  const f = makeFixture();
  try {
    const sib = join(f.root, "sib2");
    git(f.main, "worktree", "add", "-q", "-b", "axis/sib2", sib);
    const planted = plant(join(sib, "bin"), join(f.root, "ran"));
    await assert.rejects(takeSnapshot(opts(f, { gitPath: planted })), /outside every worktree/);
  } finally {
    f.cleanup();
  }
});

test("a cached git is checked again against the current worktrees", { skip: !posix }, async () => {
  const f = makeFixture();
  try {
    forgetGit();
    const bin = join(f.root, "late", "bin");
    mkdirSync(bin, { recursive: true });
    const real = resolveGit(realPath, []) as string;
    writeFileSync(join(bin, "git"), `#!/bin/sh\nexec '${real}' "$@"\n`);
    chmodSync(join(bin, "git"), 0o755);
    const env = { PATH: bin };
    const a = await takeSnapshot(opts(f, { env }));
    assert.equal(a.incomplete.length, 0, JSON.stringify(a.incomplete));
    // The directory holding the cached git is now a registered worktree: it must not be used again.
    const b = await takeSnapshot(opts(f, { env, extraWorktreeRoots: [join(f.root, "late")] }));
    assert.ok(b.incomplete.some((i) => i.id === "git" && i.blocking), JSON.stringify(b.incomplete));
  } finally {
    f.cleanup();
  }
});

test("redaction cuts its input: the output is never longer than the bound", () => {
  assert.ok(redactText("a".repeat(300_000)).length <= 64_000);
});
