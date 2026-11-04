// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { BrokerError, isUnder, nodeBrokerFs, openContained, readContained, resolveRoot, resolveTarget, writeContained, type BrokerFs } from "../src/index.js";
import { canSymlink, makeWorld } from "./helpers.js";

const worlds: Array<{ cleanup(): void }> = [];
after(() => worlds.forEach((w) => w.cleanup()));
const world = (): ReturnType<typeof makeWorld> => {
  const w = makeWorld();
  worlds.push(w);
  return w;
};
const links = canSymlink();
const skipLinks = links ? false : "symlinks are not available on this host";

async function reason(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof BrokerError, "a BrokerError");
    return e.reason;
  }
  return "no-error";
}

test("a normal file reads and writes inside the worktree", async () => {
  const w = world();
  mkdirSync(join(w.wt, "src"));
  await writeContained(w.deps(), "wt1", "src/a.txt", Buffer.from("hello"), { mode: "create", maxBytes: 100 });
  assert.equal((await readContained(w.deps(), "wt1", "src/a.txt", { maxBytes: 100 })).toString(), "hello");
  assert.equal((await readContained(w.deps(), "wt1", join(w.wt, "src", "a.txt"), { maxBytes: 100 })).toString(), "hello", "absolute inside the root");
  await writeContained(w.deps(), "wt1", "src/a.txt", Buffer.from("x"), { mode: "overwrite", maxBytes: 100 });
  assert.equal(readFileSync(join(w.wt, "src", "a.txt"), "utf8"), "x", "overwrite truncates");
});

test("dotdot, absolute outside, unregistered ids and odd inputs are refused", async () => {
  const w = world();
  const read = (id: string, p: unknown): Promise<unknown> => readContained(w.deps(), id, p as string, { maxBytes: 10 });
  assert.equal(await reason(read("wt1", "../outside/secret.txt")), "dotdot");
  assert.equal(await reason(read("wt1", "a/../../outside/secret.txt")), "dotdot");
  assert.equal(await reason(read("wt1", join(w.outside, "secret.txt"))), "outside-root");
  assert.equal(await reason(read("wt1", "/etc/passwd")), "outside-root");
  assert.equal(await reason(read("other", "a.txt")), "unregistered");
  assert.equal(await reason(read("../wt1", "a.txt")), "invalid-call");
  for (const bad of ["", "a\0b", "a\nb", 42, null, "x".repeat(5000), "a\\..\\b", "C:\\Windows\\win.ini", "C:foo", "\ud800"]) {
    assert.notEqual(await reason(read("wt1", bad)), "no-error", String(bad));
  }
  assert.equal(await reason(read("wt1", join(w.wt + "-evil", "a.txt"))), "outside-root", "a sibling with the root as a string prefix");
});

test("a symlink planted in the repository that points out is refused (file and directory)", { skip: skipLinks }, async () => {
  const w = world();
  symlinkSync(join(w.outside, "secret.txt"), join(w.wt, "link.txt"));
  symlinkSync(w.outside, join(w.wt, "dirlink"));
  assert.equal(await reason(readContained(w.deps(), "wt1", "link.txt", { maxBytes: 100 })), "symlink-escape");
  assert.equal(await reason(readContained(w.deps(), "wt1", "dirlink/secret.txt", { maxBytes: 100 })), "symlink-escape");
  assert.equal(await reason(writeContained(w.deps(), "wt1", "dirlink/new.txt", Buffer.from("x"), { mode: "create", maxBytes: 10 })), "symlink-escape");
  assert.equal(await reason(writeContained(w.deps(), "wt1", "link.txt", Buffer.from("x"), { mode: "overwrite", maxBytes: 10 })), "symlink-escape");
  assert.equal(readFileSync(join(w.outside, "secret.txt"), "utf8"), "TOP-SECRET", "the outside file is intact");
  assert.equal(existsSync(join(w.outside, "new.txt")), false);
});

test("a symlink that stays inside is followed; a dangling one is refused", { skip: skipLinks }, async () => {
  const w = world();
  writeFileSync(join(w.wt, "real.txt"), "real");
  symlinkSync("real.txt", join(w.wt, "alias.txt"));
  symlinkSync("missing.txt", join(w.wt, "dangling.txt"));
  assert.equal((await readContained(w.deps(), "wt1", "alias.txt", { maxBytes: 10 })).toString(), "real");
  assert.equal(await reason(writeContained(w.deps(), "wt1", "dangling.txt", Buffer.from("x"), { mode: "upsert", maxBytes: 10 })), "symlink-dangling");
});

test("a symlink to the local checkout, and a root that is a symlink, are refused", { skip: skipLinks }, async () => {
  const w = world();
  writeFileSync(join(w.repo, "code.txt"), "checkout");
  symlinkSync(w.repo, join(w.wt, "to-repo"));
  assert.equal(await reason(readContained(w.deps(), "wt1", "to-repo/code.txt", { maxBytes: 100 })), "symlink-escape");
  // The registered root is replaced by a symlink into the checkout after registration.
  rmSync(w.wt, { recursive: true });
  symlinkSync(w.repo, w.wt);
  assert.equal(await reason(resolveRoot(w.deps(), "wt1")), "root-moved");
  assert.equal(await reason(readContained(w.deps(), "wt1", "code.txt", { maxBytes: 100 })), "root-moved");
});

test("a worktree registered inside a repository is refused", async () => {
  const w = world();
  const inner = join(w.repo, "nested-wt");
  mkdirSync(inner);
  const reg = { get: () => ({ id: "wt1", root: inner, gitDir: join(w.base, "g") }), repositoryRoots: () => [w.repo] };
  assert.equal(await reason(resolveRoot({ registry: reg, fs: nodeBrokerFs }, "wt1")), "root-in-repository");
  const same = { get: () => ({ id: "wt1", root: w.repo, gitDir: join(w.base, "g") }), repositoryRoots: () => [w.repo] };
  assert.equal(await reason(resolveRoot({ registry: same, fs: nodeBrokerFs }, "wt1")), "root-in-repository", "the checkout itself");
});

test("swap between check and use: a directory replaced by a symlink after the check", { skip: skipLinks }, async () => {
  const w = world();
  mkdirSync(join(w.wt, "sub"));
  writeFileSync(join(w.wt, "sub", "a.txt"), "inside");
  writeFileSync(join(w.outside, "a.txt"), "OUTSIDE");
  let swapped = false;
  const racy: BrokerFs = {
    ...nodeBrokerFs,
    async open(p, m) {
      if (!swapped) {
        swapped = true;
        renameSync(join(w.wt, "sub"), join(w.wt, "sub-old"));
        symlinkSync(w.outside, join(w.wt, "sub"));
      }
      return nodeBrokerFs.open(p, m);
    },
  };
  // The path was checked as <wt>/sub/a.txt; by the time of the open <wt>/sub points outside.
  const target = await resolveTarget({ registry: w.registry, fs: nodeBrokerFs }, "wt1", "sub/a.txt", "read");
  const err = await reason(openContained({ registry: w.registry, fs: racy }, target, "read"));
  assert.equal(err, "swapped");
  assert.equal(readFileSync(join(w.outside, "a.txt"), "utf8"), "OUTSIDE");
});

test("swap between check and use: the file replaced by a symlink; a write never truncates the outside file", { skip: skipLinks }, async () => {
  const w = world();
  writeFileSync(join(w.wt, "f.txt"), "inside");
  const target = await resolveTarget(w.deps(), "wt1", "f.txt", "overwrite");
  rmSync(join(w.wt, "f.txt"));
  symlinkSync(join(w.outside, "secret.txt"), join(w.wt, "f.txt"));
  assert.equal(await reason(openContained(w.deps(), target, "overwrite")), "symlink-escape");
  assert.equal(readFileSync(join(w.outside, "secret.txt"), "utf8"), "TOP-SECRET", "not truncated");
});

test("swap between check and use: the file replaced by another file is detected by identity", async () => {
  const w = world();
  writeFileSync(join(w.wt, "f.txt"), "one");
  const target = await resolveTarget(w.deps(), "wt1", "f.txt", "read");
  rmSync(join(w.wt, "f.txt"));
  writeFileSync(join(w.wt, "f.txt"), "two");
  assert.equal(await reason(openContained(w.deps(), target, "read")), "swapped");
});

test("a hard link is refused for writes, so a file linked in from outside is not modified", async () => {
  const w = world();
  try {
    linkSync(join(w.outside, "secret.txt"), join(w.wt, "hl.txt"));
  } catch {
    return; // different file systems or no permission: nothing to test here
  }
  assert.equal(await reason(writeContained(w.deps(), "wt1", "hl.txt", Buffer.from("x"), { mode: "overwrite", maxBytes: 10 })), "hardlink");
  assert.equal(readFileSync(join(w.outside, "secret.txt"), "utf8"), "TOP-SECRET");
});

test("directories, devices and FIFOs are not regular files; size limits hold", async () => {
  const w = world();
  mkdirSync(join(w.wt, "d"));
  assert.equal(await reason(readContained(w.deps(), "wt1", "d", { maxBytes: 10 })), "not-regular");
  assert.equal(await reason(readContained(w.deps(), "wt1", ".", { maxBytes: 10 })), "not-regular");
  if (process.platform !== "win32") {
    assert.equal(spawnSync("mkfifo", [join(w.wt, "fifo")]).status, 0);
    assert.equal(await reason(readContained(w.deps(), "wt1", "fifo", { maxBytes: 10 })), "not-regular", "no hang on a FIFO");
  }
  writeFileSync(join(w.wt, "big.txt"), "0123456789ab");
  assert.equal(await reason(readContained(w.deps(), "wt1", "big.txt", { maxBytes: 10 })), "too-large");
  for (const n of [NaN, -1, 1.5, Infinity, 2 ** 40]) {
    assert.equal(await reason(readContained(w.deps(), "wt1", "big.txt", { maxBytes: n })), "invalid-call", String(n));
  }
  assert.equal(await reason(writeContained(w.deps(), "wt1", "new.txt", Buffer.alloc(20), { mode: "create", maxBytes: 10 })), "too-large");
});

test("create refuses an existing file; overwrite refuses a missing one", async () => {
  const w = world();
  writeFileSync(join(w.wt, "e.txt"), "x");
  assert.equal(await reason(writeContained(w.deps(), "wt1", "e.txt", Buffer.from("y"), { mode: "create", maxBytes: 10 })), "exists");
  assert.equal(await reason(writeContained(w.deps(), "wt1", "nope.txt", Buffer.from("y"), { mode: "overwrite", maxBytes: 10 })), "not-found");
  assert.equal(await reason(writeContained(w.deps(), "wt1", "no/parent.txt", Buffer.from("y"), { mode: "create", maxBytes: 10 })), "not-found");
});

test("case and Unicode-normalisation variants: containment compares folded names on darwin and win32", () => {
  assert.equal(isUnder("/Users/X/App/wt", "/users/x/app/WT", "darwin"), true);
  assert.equal(isUnder("/Users/X/App/wt", "/users/x/app/WT", "linux"), false);
  const nfd = "/tmp/cafe\u0301/wt";
  const nfc = "/tmp/caf\u00e9/wt";
  assert.equal(isUnder(nfd, nfc, "darwin"), true, "NFD and NFC spell the same directory on APFS");
  assert.equal(isUnder(nfd, nfc, "linux"), false);
  assert.equal(isUnder("/tmp/wt-evil", "/tmp/wt", "darwin"), false, "whole segments, not a string prefix");
  assert.equal(isUnder("C:\\Work\\WT\\a", "c:\\work\\wt", "win32"), true);
});

test("the protected flag is set from the real path as well as the spelling", { skip: skipLinks }, async () => {
  const w = world();
  mkdirSync(join(w.wt, ".github", "workflows"), { recursive: true });
  writeFileSync(join(w.wt, ".github", "workflows", "ci.yml"), "on: push");
  symlinkSync(join(w.wt, ".github", "workflows"), join(w.wt, "docs"));
  const t = await resolveTarget(w.deps(), "wt1", "docs/ci.yml", "read");
  assert.equal(t.protected?.label, ".github/workflows");
  assert.equal(t.rel, ".github/workflows/ci.yml");
  assert.equal(statSync(join(w.wt, "docs")).isDirectory(), true);
});
