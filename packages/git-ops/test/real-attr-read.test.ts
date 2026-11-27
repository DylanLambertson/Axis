// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// REV2-FIX (REV-2, G-27): real-git tests for the private attribute read.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attributeReadGit } from "../src/index.js";
import { fixture, refusal, type Fixture } from "./realFixture.js";

/** A driver script that records that it ran and then behaves like `cat`. */
function driver(f: Fixture, name: string): string {
  const p = join(f.root, `${name}.sh`);
  writeFileSync(p, `#!/bin/sh\necho ${name} >> "${f.marker}"\nif [ -n "$1" ]; then cat "$1"; else cat; fi\n`);
  chmodSync(p, 0o755);
  return p;
}

const attrOf = async (git: (s: readonly string[]) => Promise<{ code: number; stdout: string }>, name = "filter", file = "a.txt"): Promise<string> => {
  const r = await git(["check-attr", name, "--", file]);
  assert.equal(r.code, 0);
  return r.stdout.trim().split(": ").slice(2).join(": ");
};

const infoFile = (f: Fixture): string => join(f.wt.gitDir, "info", "attributes");
const setInfo = (f: Fixture, text: string): void => {
  mkdirSync(join(f.wt.gitDir, "info"), { recursive: true });
  writeFileSync(infoFile(f), text);
};
const attrDirs = (): string[] => readdirSync(tmpdir()).filter((n) => n.startsWith("axis-attr-"));

test("info/attributes is read once: a swap and restore after the read changes nothing git sees", async () => {
  const f = fixture();
  setInfo(f, "a.txt filter=lfsx\n");
  const r = await attributeReadGit(f.wt, f.deps);
  try {
    assert.equal(r.infoAttributes, "a.txt filter=lfsx\n");
    assert.equal(await attrOf(r.git), "lfsx");
    setInfo(f, "a.txt -filter\n"); // the swap
    assert.equal(await attrOf(r.git), "lfsx", "a later write to the real info/attributes reached the read");
    setInfo(f, ""); // restored / removed
    assert.equal(await attrOf(r.git), "lfsx");
    assert.equal(f.git("check-attr", "filter", "--", "a.txt").includes("unspecified"), true, "fixture: the real repository no longer has the rule");
  } finally {
    r.dispose();
  }
  // A file that appears only after the read is not seen either.
  const g = fixture();
  const r2 = await attributeReadGit(g.wt, g.deps);
  try {
    setInfo(g, "a.txt filter=late\n");
    assert.equal(await attrOf(r2.git), "unspecified");
    assert.equal(r2.infoAttributes, "");
  } finally {
    r2.dispose();
  }
});

test("user and repository attribute files are ignored unless a snapshot is handed over", async () => {
  const f = fixture();
  const user = join(f.root, "user-attrs");
  writeFileSync(user, "a.txt filter=userf\n");
  // Both the default XDG location and core.attributesFile in the repository config point at attributes.
  mkdirSync(join(f.home, ".config", "git"), { recursive: true });
  writeFileSync(join(f.home, ".config", "git", "attributes"), "a.txt filter=xdgf\n");
  f.git("config", "core.attributesFile", user);
  assert.equal(f.git("check-attr", "filter", "--", "a.txt").trim().endsWith("userf"), true, "fixture: plain git reads the configured file");
  const plain = await attributeReadGit(f.wt, f.deps);
  try {
    assert.equal(await attrOf(plain.git), "unspecified");
  } finally {
    plain.dispose();
  }
  const snap = await attributeReadGit(f.wt, f.deps, { userAttributesFile: user });
  try {
    assert.equal(await attrOf(snap.git), "userf");
    writeFileSync(user, "a.txt -filter\n");
    assert.equal(await attrOf(snap.git), "userf", "the user file was read after the snapshot");
  } finally {
    snap.dispose();
  }
});

test("the request carries the private git directory, the system-file switch and no repository-location variable", async () => {
  const f = fixture();
  const r = await attributeReadGit(f.wt, f.deps);
  try {
    f.seen.length = 0;
    await attrOf(r.git);
    const req = f.seen.at(-1);
    assert.ok(req);
    assert.equal(req.env["GIT_ATTR_NOSYSTEM"], "1");
    for (const n of Object.keys(req.env)) assert.equal(/^GIT_(DIR|WORK_TREE|OBJECT_DIRECTORY|ALTERNATE|CONFIG)/.test(n), false, n);
    const gd = req.argv.find((a) => a.startsWith("--git-dir=")) as string;
    assert.ok(gd.length > 10 && gd !== `--git-dir=${f.wt.gitDir}`);
    assert.ok(req.argv.some((a) => a.startsWith("core.attributesFile=") && a.includes("user-attributes")));
    assert.ok(req.argv.indexOf("check-attr") > req.argv.indexOf("core.attributesFile=" + (req.argv.find((a) => a.startsWith("core.attributesFile=")) as string).slice(20)), "pins come before the subcommand");
    assert.ok(readFileSync(join(gd.slice(10), "objects", "info", "alternates"), "utf8").trim().endsWith(join(f.wt.gitDir, "objects")));
  } finally {
    r.dispose();
  }
});

test("planted filter, textconv and external diff drivers run nothing through the attribute read", async () => {
  const f = fixture();
  const clean = driver(f, "clean");
  const smudge = driver(f, "smudge");
  const textconv = driver(f, "textconv");
  const ext = driver(f, "extdiff");
  const globalClean = driver(f, "globalclean");
  const repo = f.wt.workTree;
  // Drivers in the repository config AND in the user's global config (the private read must not find either).
  for (const g of [[], ["--global"]] as const) {
    f.run(repo, "config", ...g, "filter.x.clean", clean);
    f.run(repo, "config", ...g, "filter.x.smudge", smudge);
    f.run(repo, "config", ...g, "filter.x.required", "true");
    f.run(repo, "config", ...g, "diff.x.textconv", textconv);
    f.run(repo, "config", ...g, "diff.external", ext);
  }
  f.run(repo, "config", "--global", "filter.g.clean", globalClean);
  setInfo(f, "a.txt filter=x diff=x\n");
  writeFileSync(join(repo, ".gitattributes"), "*.txt filter=x diff=x\nb.txt filter=g\n");
  writeFileSync(join(repo, "b.txt"), "b\n");
  f.git("add", "-A");
  f.git("-c", "filter.x.clean=cat", "-c", "filter.x.smudge=cat", "-c", "filter.x.required=false", "commit", "-q", "-m", "attrs");
  writeFileSync(join(repo, "a.txt"), "two\n");
  f.git("-c", "filter.x.clean=cat", "commit", "-q", "-am", "edit");
  writeFileSync(f.marker, "");
  // Sanity: the same drivers do run when git is used without the private read, so the markers can tell.
  f.git("hash-object", "--path=a.txt", "a.txt");
  f.git("cat-file", "--filters", "HEAD:a.txt");
  f.git("diff", "--textconv", "--no-ext-diff", "HEAD~1", "HEAD");
  f.git("diff", "HEAD~1", "HEAD");
  const ran = readFileSync(f.marker, "utf8");
  for (const n of ["clean", "smudge", "textconv", "extdiff"]) assert.ok(ran.includes(n), `fixture: ${n} runs unprotected`);
  writeFileSync(f.marker, "");
  // Refs are not part of the private directory: callers hand over object ids.
  const [head, prev] = [f.git("rev-parse", "HEAD").trim(), f.git("rev-parse", "HEAD~1").trim()];
  const r = await attributeReadGit(f.wt, f.deps);
  try {
    const calls: Array<readonly string[]> = [
      ["check-attr", "-a", "--", "a.txt", "b.txt"],
      ["hash-object", "--path=a.txt", "--", "a.txt"],
      ["hash-object", "--path=b.txt", "--", "b.txt"],
      ["cat-file", "--filters", `${head}:a.txt`],
      ["diff", "--no-ext-diff", "--no-textconv", prev, head],
      ["diff", prev, head],
      ["diff", "--textconv", prev, head],
      ["diff", "--ext-diff", "--textconv", prev, head],
      ["diff-tree", "-p", "--no-ext-diff", "--no-textconv", head],
    ];
    for (const c of calls) {
      const res = await r.git(c);
      assert.equal(res.code, 0, `${c.join(" ")}: ${res.stderr}`);
    }
    assert.equal(readFileSync(f.marker, "utf8"), "", "a driver ran during an attribute read");
    assert.equal(existsSync(f.marker), true);
  } finally {
    r.dispose();
  }
});

test("a linked worktree reads info/attributes of the common directory, once", async () => {
  const f = fixture();
  setInfo(f, "a.txt filter=common\n");
  const linked = join(f.root, "linked");
  f.git("worktree", "add", "-q", "-b", "axis/other", linked);
  const gitDir = f.run(linked, "rev-parse", "--absolute-git-dir").trim();
  assert.notEqual(gitDir, f.wt.gitDir);
  const r = await attributeReadGit({ workTree: linked, gitDir }, f.deps);
  try {
    assert.equal(r.infoAttributes, "a.txt filter=common\n");
    assert.equal(await attrOf(r.git), "common");
  } finally {
    r.dispose();
  }
});

test("an oversize or non-file attribute source is refused and leaves no private directory", async () => {
  const f = fixture();
  const before = attrDirs().length;
  setInfo(f, "# " + "x".repeat(1024 * 1024) + "\n");
  assert.equal((await refusal(attributeReadGit(f.wt, f.deps))).code, "E_POLICY_DENIED");
  writeFileSync(infoFile(f), "");
  mkdirSync(join(f.root, "dirattr"));
  assert.equal((await refusal(attributeReadGit(f.wt, f.deps, { userAttributesFile: join(f.root, "dirattr") }))).code, "E_POLICY_DENIED");
  assert.equal(attrDirs().length, before);
  // A failure after the private directory exists (git cannot be run) removes it too.
  const broken = { ...f.deps, runner: { run: async () => ({ code: 1, stdout: "", stderr: "" }) } };
  assert.equal((await refusal(attributeReadGit(f.wt, broken))).code, "E_UNAVAILABLE");
  assert.equal(attrDirs().length, before, "a failed setup left its private directory behind");
});

test("dispose removes the private directory", async () => {
  const f = fixture();
  f.seen.length = 0;
  const r = await attributeReadGit(f.wt, f.deps);
  await attrOf(r.git);
  const gd = (f.seen.at(-1)?.argv.find((a) => a.startsWith("--git-dir=")) as string).slice(10);
  assert.equal(existsSync(gd), true);
  r.dispose();
  assert.equal(existsSync(gd), false);
});

test("info/attributes is snapshotted byte for byte, including bytes that are not UTF-8", async () => {
  const f = fixture();
  const bytes = Buffer.concat([Buffer.from([0xff]), Buffer.from(".txt binary\n")]);
  mkdirSync(join(f.wt.gitDir, "info"), { recursive: true });
  writeFileSync(infoFile(f), bytes);
  const r = await attributeReadGit(f.wt, f.deps);
  try {
    assert.deepEqual(Buffer.from(r.infoAttributesBytes), bytes);
    f.seen.length = 0;
    await attrOf(r.git);
    const gd = (f.seen.at(-1)?.argv.find((a) => a.startsWith("--git-dir=")) as string).slice(10);
    assert.deepEqual(readFileSync(join(gd, "info", "attributes")), bytes, "the copy git reads differs from the source");
  } finally {
    r.dispose();
  }
});

test("a relative user attributes file and a git directory that cannot go in an alternates file are refused", async () => {
  const f = fixture();
  assert.equal((await refusal(attributeReadGit(f.wt, f.deps, { userAttributesFile: "attrs" }))).code, "E_INVALID_ARGUMENT");
  const odd = join(f.root, "re\npo", ".git");
  try {
    mkdirSync(odd, { recursive: true });
  } catch {
    return; // a file system that cannot name a line break has nothing to test
  }
  assert.equal((await refusal(attributeReadGit({ workTree: join(f.root, "re\npo"), gitDir: odd }, f.deps))).code, "E_POLICY_DENIED");
});
