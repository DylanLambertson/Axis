// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
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

// `worktree add --relative-paths` came with git 2.48 (and is not listed in `-h`), so the version decides.
const hasRelative = ((): boolean => {
  const m = /git version (\d+)\.(\d+)/.exec(spawnSync("git", ["--version"], { encoding: "utf8" }).stdout);
  return m !== null && (Number(m[1]) > 2 || (Number(m[1]) === 2 && Number(m[2]) >= 48));
})();

test("sibling list: a relative gitdir file (git --relative-paths) still excludes the sibling's git", { skip: !posix }, async (t) => {
  if (!hasRelative) return t.skip(`SKIPPED: the installed git has no 'worktree add --relative-paths' (needs git 2.48 or newer), so relative gitdir files cannot be staged`);
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
    const refused = await takeSnapshot(opts(f, { gitPath: planted }));
    assert.ok(refused.incomplete.some((i) => i.id === "git" && i.blocking), JSON.stringify(refused.incomplete));
    assert.equal(existsSync(marker), false);
  } finally {
    f.cleanup();
  }
});

test("an injected gitPath inside a sibling worktree is refused, with no extraWorktreeRoots", { skip: !posix }, async () => {
  const f = makeFixture();
  try {
    const sib = join(f.root, "sib2");
    git(f.main, "worktree", "add", "-q", "-b", "axis/sib2", sib);
    const marker = join(f.root, "ran");
    const planted = plant(join(sib, "bin"), marker);
    const s = await takeSnapshot(opts(f, { gitPath: planted }));
    assert.ok(s.incomplete.some((i) => i.id === "git" && i.blocking), JSON.stringify(s.incomplete));
    assert.equal(judgeDrift({ baseline: s, current: s }).status, "refused");
    assert.equal(existsSync(marker), false);
    // The caller's own roots are still a caller error.
    await assert.rejects(takeSnapshot(opts(f, { gitPath: join(f.wt, "git") })), /outside every worktree/);
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

test("redaction cuts its input to the bound before any pattern runs", () => {
  // The cut to 64,000 characters is visible in the audit redactor's marker, which records the length it was given.
  assert.match(redactText("word ".repeat(60_000)), /\[TRUNCATED:64000\]$/);
});

test("a gitdir that resolves to the file system root refuses the snapshot, it does not throw", { skip: !posix }, async () => {
  const f = makeFixture();
  try {
    mkdirSync(join(f.common, "worktrees", "zz"));
    writeFileSync(join(f.common, "worktrees", "zz", "gitdir"), "/.git\n");
    const real = resolveGit(realPath, []) as string;
    for (const more of [{}, { gitPath: real }]) {
      const s = await takeSnapshot(opts(f, more));
      assert.equal(judgeDrift({ baseline: s, current: s }).status, "refused");
    }
  } finally {
    f.cleanup();
  }
});

test("an unreadable worktrees directory blocks", { skip: !posix || process.getuid?.() === 0 }, async () => {
  const f = makeFixture();
  try {
    chmodSync(join(f.common, "worktrees"), 0);
    const s = await takeSnapshot(opts(f));
    chmodSync(join(f.common, "worktrees"), 0o755);
    assert.ok(s.incomplete.some((i) => i.blocking && i.id === "worktrees"), JSON.stringify(s.incomplete));
  } finally {
    chmodSync(join(f.common, "worktrees"), 0o755);
    f.cleanup();
  }
});

test("more worktrees than maxWorktrees: the reason names that limit, and raising it helps", { skip: !posix }, async () => {
  const f = makeFixture();
  try {
    for (let i = 0; i < 5; i++) mkdirSync(join(f.common, "worktrees", `w${i}`));
    const low = await takeSnapshot(opts(f, { limits: { maxWorktrees: 3 } }));
    assert.ok(low.incomplete.some((i) => i.blocking && /maxWorktrees/.test(i.reason)), JSON.stringify(low.incomplete));
    const high = await takeSnapshot(opts(f, { limits: { maxWorktrees: 50 } }));
    assert.ok(!high.incomplete.some((i) => /maxWorktrees/.test(i.reason)));
  } finally {
    f.cleanup();
  }
});

test("the default worktree cap is 1024: 260 entries are not refused for their number", { skip: !posix }, async () => {
  const f = makeFixture();
  try {
    for (let i = 0; i < 260; i++) mkdirSync(join(f.common, "worktrees", `w${i}`));
    const s = await takeSnapshot(opts(f));
    assert.ok(!s.incomplete.some((i) => /maxWorktrees|entries/.test(i.reason)), JSON.stringify(s.incomplete.slice(0, 3)));
  } finally {
    f.cleanup();
  }
});

test("every worktree entry the single listing names has its link records", { skip: !posix }, async () => {
  const f = makeFixture();
  try {
    const { readdirSync } = await import("node:fs");
    const s = await takeSnapshot(opts(f));
    assert.ok(readdirSync(join(f.common, "worktrees")).length >= 1);
    for (const n of readdirSync(join(f.common, "worktrees"))) assert.ok(s.entries.some((e) => e.id === `worktrees/${n}/gitdir`), n);
  } finally {
    f.cleanup();
  }
});
