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
