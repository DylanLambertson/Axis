// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Real-git regression tests for the daemon-side secret scan of an outgoing push.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { planPush } from "../src/index.js";
import { baseOf, fixture } from "./realFixture.js";

/** A secret-shaped value assembled at runtime so no literal looks like a credential. */
export const AWS_KEY = ["AK", "IA", "ABCDEFGHIJKLMNOP"].join("");

export const scanFor = (seen: string[]) => async (d: string) => {
  seen.push(d);
  return d.includes(AWS_KEY) ? [{ rule: "aws-key" }] : [];
};

test("B-1: a submodule diff.submodule=diff preference cannot run a nested repository's diff.external in the daemon", async () => {
  const f = fixture({ scanner: async () => [] });
  const evil = join(f.root, "evil.sh");
  writeFileSync(evil, `#!/bin/sh\necho daemon-exec >> "${f.marker}"\n`);
  chmodSync(evil, 0o755);
  const repo = f.wt.workTree;
  const sub = join(repo, "sub");
  f.run(repo, "init", "-q", "sub");
  for (const [k, v] of [["user.name", "x"], ["user.email", "x@x"], ["diff.external", evil]] as const) f.run(sub, "config", k, v);
  writeFileSync(join(sub, "x"), "1\n");
  f.run(sub, "add", "x");
  f.run(sub, "commit", "-q", "-m", "s1");
  const s1 = f.run(sub, "rev-parse", "HEAD").trim();
  writeFileSync(join(sub, "x"), "2\n");
  f.run(sub, "commit", "-q", "-am", "s2");
  const s2 = f.run(sub, "rev-parse", "HEAD").trim();
  f.git("update-index", "--add", "--cacheinfo", `160000,${s1},sub`);
  f.git("commit", "-q", "-m", "sub1");
  f.git("push", "-q", "origin", "axis/feat");
  f.git("update-index", "--cacheinfo", `160000,${s2},sub`);
  f.git("commit", "-q", "-m", "sub2");
  f.run(repo, "config", "--global", "diff.submodule", "diff");
  // Sanity: the unhardened diff does run it, so the fixture is not vacuous.
  f.git("diff", "--no-ext-diff", "--no-textconv", "HEAD~1", "HEAD");
  assert.ok(existsSync(f.marker), "fixture: an unhardened submodule diff runs diff.external");
  writeFileSync(f.marker, "");
  await planPush(f.deps, { worktree: f.wt, remote: "origin", branch: "axis/feat", baseSha: baseOf(f) });
  assert.equal(readFileSync(f.marker, "utf8"), "", "a program from worktree-controlled config ran in the daemon during the secret-scan diff");
});

test("B-2: in a partial clone the scan diff cannot lazy-fetch through remote.<n>.uploadpack in the daemon", async () => {
  const f = fixture({ scanner: async () => [] });
  const repo = f.wt.workTree;
  f.run(repo, "config", "uploadpack.allowFilter", "true");
  writeFileSync(join(repo, "a.txt"), "two\n");
  f.git("commit", "-q", "-am", "second");
  const up = join(f.root, "up.sh");
  writeFileSync(up, `#!/bin/sh\necho daemon-exec >> "${f.marker}"\nexec git-upload-pack "$@"\n`);
  chmodSync(up, 0o755);
  f.run(repo, "config", "--global", "remote.origin.uploadpack", up);
  const clone = (name: string): string => {
    const pc = join(f.root, name);
    f.run(f.root, "clone", "-q", "--filter=blob:none", "--no-checkout", `file://${repo}`, pc);
    for (const [k, v] of [["user.name", "Dylan Lambertson"], ["user.email", "me@dylanlambertson.dev"]] as const) f.run(pc, "config", k, v);
    f.run(pc, "checkout", "-q", "axis/feat");
    f.run(pc, "branch", "-q", "main", "origin/main");
    f.run(pc, "update-ref", "-d", "refs/remotes/origin/axis/feat");
    return pc;
  };
  // Sanity, on a clone of its own (a fetch fills the object store): an unhardened diff does fetch, through the planted program.
  f.run(clone("probe"), "diff", "--no-ext-diff", "main", "axis/feat");
  assert.ok(existsSync(f.marker), "fixture: a partial-clone diff runs the uploadpack program");
  writeFileSync(f.marker, "");
  const pc = clone("pc");
  writeFileSync(f.marker, "");
  const wt = { workTree: pc, gitDir: join(pc, ".git") };
  await planPush(f.deps, { worktree: wt, remote: "origin", branch: "axis/feat", baseSha: f.run(pc, "rev-parse", "main").trim() }).catch(() => undefined);
  assert.equal(readFileSync(f.marker, "utf8"), "", "the daemon ran a transport program during a lazy fetch");
});

test("S-6: a refs/replace entry cannot show the scanner clean content in place of the blob that is pushed", async () => {
  const seen: string[] = [];
  const f = fixture({ scanner: scanFor(seen), scanMode: "refuse" });
  const repo = f.wt.workTree;
  writeFileSync(join(repo, "prod.env"), `AWS=${AWS_KEY}\n`);
  f.git("add", "-A");
  f.git("commit", "-q", "-m", "add env");
  const secretBlob = f.git("rev-parse", "HEAD:prod.env").trim();
  writeFileSync(join(f.root, "clean.txt"), "AWS=redacted\n");
  const clean = f.run(repo, "hash-object", "-w", join(f.root, "clean.txt")).trim();
  f.git("replace", secretBlob, clean);
  assert.ok(!f.git("diff", "main", "HEAD").includes(AWS_KEY), "fixture: an unhardened diff honours the replacement");
  const e = await planPush(f.deps, { worktree: f.wt, remote: "origin", branch: "axis/feat", baseSha: baseOf(f) }).then(() => undefined, (x: unknown) => x);
  assert.ok(e instanceof Error && /secret pattern/.test(e.message), `the scan did not see the real blob; scanner got ${JSON.stringify(seen)}`);
});

test("S-1: a remote-tracking ref planted in the worktree does not narrow the scanned range", async () => {
  const seen: string[] = [];
  const f = fixture({ scanner: scanFor(seen), scanMode: "refuse" });
  writeFileSync(join(f.wt.workTree, ".env"), `AWS=${AWS_KEY}\n`);
  f.git("add", "-A");
  f.git("commit", "-q", "-m", "add env");
  f.git("update-ref", "refs/remotes/origin/axis/feat", "HEAD"); // the remote has no such branch
  const e = await planPush(f.deps, { worktree: f.wt, remote: "origin", branch: "axis/feat", baseSha: baseOf(f) }).then(() => undefined, (x: unknown) => x);
  assert.ok(e instanceof Error && /secret pattern/.test(e.message), `the scan was narrowed; scanner got ${JSON.stringify(seen)}`);
});

test("S-1: a base that is missing, malformed or not an ancestor of the tip is refused", async () => {
  const f = fixture({ scanner: async () => [] });
  const input = { worktree: f.wt, remote: "origin", branch: "axis/feat" };
  const codeOf = async (baseSha: unknown): Promise<string> => planPush(f.deps, { ...input, baseSha } as never).then(() => "OK", (e: { code: string }) => e.code);
  assert.equal(await codeOf(undefined), "E_INVALID_ARGUMENT");
  assert.equal(await codeOf("main"), "E_INVALID_ARGUMENT");
  assert.equal(await codeOf("0".repeat(40)), "E_CONFLICT", "not in the repository");
  // A commit that exists but is not an ancestor of the tip (history rewritten since the base was recorded).
  f.git("checkout", "-q", "--orphan", "other");
  writeFileSync(join(f.wt.workTree, "z.txt"), "z\n");
  f.git("add", "-A");
  f.git("commit", "-q", "-m", "unrelated");
  const stray = f.git("rev-parse", "HEAD").trim();
  f.git("checkout", "-q", "axis/feat");
  assert.equal(await codeOf(stray), "E_CONFLICT", "not an ancestor");
  assert.equal(await codeOf(baseOf(f)), "OK");
});
