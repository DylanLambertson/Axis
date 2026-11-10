// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// REV2-FIX second half: the system-file snapshot, reads of tracked attributes from a chosen index, and SHA-256 stores.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { attributeReadGit, createNodeRunner, type GitOpsDeps } from "../src/index.js";
import { PATHS, fixture, refusal, tmp } from "./realFixture.js";

type Git = (s: readonly string[], stdin?: string) => Promise<{ code: number; stdout: string; stderr: string }>;

const attrOf = async (git: Git, file: string, cached = false): Promise<string> => {
  const r = await git(["check-attr", ...(cached ? ["--cached"] : []), "filter", "--", file]);
  assert.equal(r.code, 0, r.stderr);
  return r.stdout.trim().split(": ").slice(2).join(": ");
};

test("the system file is snapshotted below the user file, in one private core.attributesFile", async () => {
  const f = fixture();
  const sys = join(f.root, "sys-attrs");
  const user = join(f.root, "user-attrs");
  // No final line break in the system file: its last line must not run into the user file's first.
  writeFileSync(sys, "a.txt filter=sysf\nb.txt filter=sysb");
  writeFileSync(user, "a.txt filter=userf\n");
  const r = await attributeReadGit(f.wt, f.deps, { systemAttributesFile: sys, userAttributesFile: user });
  try {
    assert.equal(await attrOf(r.git, "a.txt"), "userf", "the user file outranks the system file, as in git");
    assert.equal(await attrOf(r.git, "b.txt"), "sysb");
    assert.equal(r.outsideAttributes, "a.txt filter=sysf\nb.txt filter=sysb\na.txt filter=userf\n");
    assert.deepEqual(Buffer.from(r.outsideAttributesBytes), Buffer.from(r.outsideAttributes));
    writeFileSync(sys, "b.txt -filter\n");
    assert.equal(await attrOf(r.git, "b.txt"), "sysb", "the system file was read after the snapshot");
  } finally {
    r.dispose();
  }
  const only = await attributeReadGit(f.wt, f.deps, { systemAttributesFile: sys });
  try {
    assert.equal(await attrOf(only.git, "b.txt"), "unset");
    assert.equal(only.outsideAttributes, "b.txt -filter\n");
  } finally {
    only.dispose();
  }
  assert.equal((await refusal(attributeReadGit(f.wt, f.deps, { systemAttributesFile: "sys-attrs" }))).code, "E_INVALID_ARGUMENT");
});

test("withIndex reads tracked attributes from the index it names, inside the same snapshot", async () => {
  const f = fixture();
  writeFileSync(join(f.wt.workTree, ".gitattributes"), "a.txt filter=tree\n");
  f.git("add", "-A");
  const tree = f.git("write-tree").trim();
  f.git("reset", "-q");
  writeFileSync(join(f.wt.workTree, ".gitattributes"), "a.txt filter=live\n");
  const idx = join(f.root, "side-index");
  execFileSync("git", ["read-tree", tree], { cwd: f.wt.workTree, env: { ...f.env, GIT_INDEX_FILE: idx } });
  mkdirSync(join(f.wt.gitDir, "info"), { recursive: true });
  writeFileSync(join(f.wt.gitDir, "info", "attributes"), "*.md filter=info\n");
  const r = await attributeReadGit(f.wt, f.deps);
  try {
    writeFileSync(join(f.wt.gitDir, "info", "attributes"), "a.txt -filter\n");
    const side = await r.withIndex(idx);
    assert.equal(await attrOf(side, "a.txt", true), "tree");
    assert.equal(await attrOf(side, "x.md", true), "info", "the index read uses the same info/attributes snapshot");
    assert.equal(await attrOf(r.git, "a.txt", true), "unspecified", "the base caller still has no index");
    assert.equal(await attrOf(r.git, "a.txt"), "live", "fixture: without --cached git reads the work tree");
    await assert.rejects(r.withIndex("side-index"), (e: { code?: string }) => e.code === "E_INVALID_ARGUMENT");
  } finally {
    r.dispose();
  }
});

test("a SHA-256 repository is read when its object format is named, and an unknown format is refused", async (t) => {
  const root = tmp("axis-attr-sha256-");
  const env = { PATH: PATHS, HOME: root, GIT_CONFIG_NOSYSTEM: "1" };
  const repo = join(root, "repo");
  try {
    execFileSync("git", ["init", "-q", "--object-format=sha256", repo], { env, stdio: "ignore" });
  } catch {
    t.skip("this git cannot make a SHA-256 repository");
    return;
  }
  const run = (...a: string[]): string => execFileSync("git", a, { cwd: repo, env, encoding: "utf8" });
  writeFileSync(join(repo, ".gitattributes"), "a.txt filter=deep\n");
  run("add", "-A");
  const tree = run("write-tree").trim();
  assert.equal(tree.length, 64);
  const idx = join(root, "idx");
  execFileSync("git", ["read-tree", tree], { cwd: repo, env: { ...env, GIT_INDEX_FILE: idx } });
  const deps: GitOpsDeps = {
    runner: createNodeRunner({ allowPtyContext: true, allowUnpinnedGit: true }),
    env: { daemon: { PATH: PATHS, HOME: root }, pty: { PATH: PATHS, HOME: root } },
    runHooks: false,
    isCliRunActive: () => false,
    assertNoDrift: async () => undefined,
  };
  const w = { workTree: repo, gitDir: join(repo, ".git") };
  const r = await attributeReadGit(w, deps, { objectFormat: "sha256" });
  try {
    assert.equal(await attrOf(await r.withIndex(idx), "a.txt", true), "deep");
    const cat = await r.git(["cat-file", "-t", tree]);
    assert.equal(cat.stdout.trim(), "tree", "the store is read through the alternates file");
  } finally {
    r.dispose();
  }
  const sha1 = await attributeReadGit(w, deps);
  try {
    assert.notEqual((await sha1.git(["cat-file", "-t", tree])).code, 0, "a SHA-1 private directory cannot name a SHA-256 object (so the option is needed)");
  } finally {
    sha1.dispose();
  }
  assert.equal((await refusal(attributeReadGit(w, deps, { objectFormat: "md5" as never }))).code, "E_INVALID_ARGUMENT");
});
