// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Real-git regression tests for the daemon-side secret scan of an outgoing push.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { planPush } from "../src/index.js";
import { fixture } from "./realFixture.js";

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
  await planPush(f.deps, { worktree: f.wt, remote: "origin", branch: "axis/feat" });
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
  await planPush(f.deps, { worktree: wt, remote: "origin", branch: "axis/feat", base: "main" }).catch(() => undefined);
  assert.equal(readFileSync(f.marker, "utf8"), "", "the daemon ran a transport program during a lazy fetch");
});
