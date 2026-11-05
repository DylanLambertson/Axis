// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { judgeDrift, takeSnapshot, type TakeOptions } from "../src/index.js";
import { redactText } from "../src/display.js";
import { forgetGit, parseListOutput, resolveGit } from "../src/git.js";
import { git, makeFixture, write, type Fixture } from "./helpers.js";

const posix = process.platform !== "win32";
const realPath = process.env["PATH"] ?? "";
const opts = (f: Fixture, more: Partial<TakeOptions> = {}): TakeOptions => ({ worktreePath: f.wt, commonDir: f.common, homeDir: f.home, ...more });

/** A shell script `git` in `dir` that runs `pre` first and then the real git. */
function wrapper(dir: string, pre = ""): string {
  const real = resolveGit(realPath, []);
  assert.ok(real !== null, "a git must be installed to run these tests");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "git");
  writeFileSync(path, `#!/bin/sh\n${pre}\nexec '${real}' "$@"\n`);
  chmodSync(path, 0o755);
  return path;
}

test("R1: redaction patterns are linear: long runs of scheme characters do not stall the event loop", () => {
  const line = "a".repeat(16_000);
  const t0 = Date.now();
  for (let i = 0; i < 20; i++) redactText(line);
  redactText(`${"a:".repeat(8000)}`);
  redactText("a".repeat(15_000) + "://x");
  redactText("x".repeat(200_000));
  assert.ok(Date.now() - t0 < 1500, `redaction took ${Date.now() - t0} ms`);
});

test("R1b: a credential with no @ left (git ends a value at #) is redacted, a host and port is not", () => {
  assert.equal(redactText("url = https://bob:hunter2"), "url = https://[REDACTED]");
  assert.equal(redactText("https://host:8080/x"), "https://host:8080/x");
  assert.equal(redactText("https://bob:pw@host"), "https://[REDACTED]@host");
});

test("R2: the snapshot's own -c core.fsmonitor=false is not a repository setting", { skip: !posix }, async () => {
  const f = makeFixture();
  try {
    const s = await takeSnapshot(opts(f));
    assert.ok(!s.settings.some((x) => x.key === "core.fsmonitor"), JSON.stringify(s.settings));
    // When git cannot be asked, a baseline that had no such setting shows no "removed" flag for it either.
    const none = await takeSnapshot(opts(f, { env: { PATH: "" } }));
    assert.ok(!none.settings.some((x) => x.key === "core.fsmonitor"));
  } finally {
    f.cleanup();
  }
});

test("R3a: a git planted in a sibling registered worktree on PATH never runs, even with no extraWorktreeRoots", { skip: !posix }, async () => {
  const f = makeFixture();
  try {
    const sibling = join(f.root, "sibling");
    git(f.main, "worktree", "add", "-q", "-b", "axis/sib", sibling);
    const marker = join(f.root, "ran");
    mkdirSync(join(sibling, "bin"));
    writeFileSync(join(sibling, "bin", "git"), `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
    chmodSync(join(sibling, "bin", "git"), 0o755);
    forgetGit();
    const s = await takeSnapshot(opts(f, { env: { PATH: `${join(sibling, "bin")}:${realPath}` } }));
    assert.equal(existsSync(marker), false, "the sibling's git ran");
    assert.equal(s.incomplete.length, 0, JSON.stringify(s.incomplete));
  } finally {
    f.cleanup();
  }
});

test("R3b: git is resolved once per PATH: one dropped in an earlier directory later is not picked up; a vanished one is re-resolved", { skip: !posix }, async () => {
  const f = makeFixture();
  try {
    forgetGit();
    const first = join(f.root, "first");
    const second = join(f.root, "second");
    const marker = join(f.root, "later");
    const env = { PATH: `${first}:${second}:${realPath}` };
    mkdirSync(first);
    wrapper(second, `echo x >> '${join(f.root, "second.log")}'`);
    const a = await takeSnapshot(opts(f, { env }));
    assert.equal(a.incomplete.length, 0, JSON.stringify(a.incomplete));
    assert.ok(existsSync(join(f.root, "second.log")), "the first resolution is the second directory");
    writeFileSync(join(first, "git"), `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
    chmodSync(join(first, "git"), 0o755);
    const b = await takeSnapshot(opts(f, { env }));
    assert.equal(existsSync(marker), false, "a git dropped in later was picked up");
    assert.equal(b.incomplete.length, 0, JSON.stringify(b.incomplete));
    // The cached git vanishes: one re-resolution through the trusted function (which now finds the one in `first`).
    rmSync(join(second, "git"));
    await takeSnapshot(opts(f, { env }));
    assert.equal(existsSync(marker), true, "a vanished git is re-resolved from PATH");
  } finally {
    f.cleanup();
  }
});

test("R4: the git that reports dubious ownership without safe.directory is read when it is passed", { skip: !posix }, async () => {
  const f = makeFixture();
  try {
    const dubious = `case "$*" in *safe.directory=${f.wt}*) ;; *) echo "fatal: detected dubious ownership in repository" >&2; exit 128;; esac`;
    const g = wrapper(join(f.root, "bin"), dubious);
    const s = await takeSnapshot(opts(f, { gitPath: g }));
    assert.equal(s.incomplete.length, 0, JSON.stringify(s.incomplete));
    assert.equal(judgeDrift({ baseline: s, current: s }).status, "clean");
  } finally {
    f.cleanup();
  }
});

test("R5: git's output is bounded: a flood from config --list leaves the snapshot incomplete, not parsed", { skip: !posix }, async () => {
  const f = makeFixture();
  try {
    const g = wrapper(join(f.root, "bin"), `case "$*" in *"config --list"*) head -c 3000000 /dev/zero; exit 0;; esac`);
    const s = await takeSnapshot(opts(f, { gitPath: g, limits: { maxConfigBytes: 100_000 } }));
    assert.ok(s.incomplete.some((i) => i.blocking && /git could not read the configuration/.test(i.reason)), JSON.stringify(s.incomplete));
  } finally {
    f.cleanup();
  }
});

test("R6: too many config entries say so", { skip: !posix }, async () => {
  const f = makeFixture();
  try {
    for (let i = 0; i < 30; i++) git(f.main, "config", `branch.b${i}.remote`, "origin");
    const s = await takeSnapshot(opts(f, { limits: { maxSettings: 2 } }));
    assert.ok(s.incomplete.some((i) => i.blocking && /more than 16 entries/.test(i.reason)), JSON.stringify(s.incomplete));
    assert.equal(parseListOutput(Buffer.from("file:a\0x.y\nz\0file:a\0x.y\nz\0"), 1), null);
  } finally {
    f.cleanup();
  }
});

test("R7: a config file over the size limit is not handed to git to list", { skip: !posix }, async () => {
  const f = makeFixture();
  try {
    const log = join(f.root, "calls.log");
    const g = wrapper(join(f.root, "bin"), `echo "$*" >> '${log}'`);
    write(join(f.common, "config"), `${"# padding\n".repeat(600)}[core]\n\tbare = false\n`);
    const s = await takeSnapshot(opts(f, { gitPath: g, limits: { maxConfigBytes: 2000 } }));
    assert.ok(s.incomplete.some((i) => i.blocking && /over the size limit/.test(i.reason)), JSON.stringify(s.incomplete));
    const calls = existsSync(log) ? readFileSync(log, "utf8") : "";
    assert.ok(!/config --list/.test(calls), "git was asked to list the oversize config");
  } finally {
    f.cleanup();
  }
});

test("R8: a file that only git read blocks, whatever the parser found", { skip: !posix }, async () => {
  const f = makeFixture();
  try {
    const extra = join(f.root, "only-git.conf");
    write(extra, "[alias]\n\tzz = status\n");
    const real = resolveGit(realPath, []) as string;
    const g = wrapper(join(f.root, "bin"), `case "$*" in *"config --list"*) '${real}' "$@"; printf 'file:${extra}\\0alias.zz\\nstatus\\0'; exit 0;; esac`);
    const s = await takeSnapshot(opts(f, { gitPath: g }));
    assert.ok(s.incomplete.some((i) => i.blocking && /git read a file the parser did not find/.test(i.reason)), JSON.stringify(s.incomplete));
  } finally {
    f.cleanup();
  }
});
