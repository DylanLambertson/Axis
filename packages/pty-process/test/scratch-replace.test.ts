// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// HOOK-REPLACE-1: refs/replace cannot change what the scratch steps and the hook see. Real git.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { begin, GIT, gitRig, nextReq, SKIP, verifyAttempt } from "../testing/git.js";

test("HOOK-REPLACE-1: with the reviewed tree and HEAD replaced, scratch-begin, read-tree, the hook's diff --cached and write-tree all see the real objects", { skip: SKIP }, async (t) => {
  const r = gitRig();
  t.after(() => r.cleanup());
  const repo = r.repo("replaced");
  const top = repo.top;
  const blob = (s: string): string => r.git(["hash-object", "-w", "--stdin"], top, s).trim();
  const a = r.git(["rev-parse", "HEAD:a.txt"], top).trim();
  const mk = (rows: string[]): string => r.git(["mktree"], top, rows.join("")).trim();
  // The reviewed tree T holds a planted secret file; the replacement T2 hides it and shows a decoy.
  const reviewed = mk([`100644 blob ${a}\ta.txt\n`, `100644 blob ${blob("planted secret\n")}\tsecret.txt\n`]);
  const decoy = mk([`100644 blob ${a}\ta.txt\n`, `100644 blob ${blob("decoy\n")}\tdecoy.txt\n`]);
  const head = r.git(["rev-parse", "HEAD"], top).trim();
  const fakeHead = r.git(["commit-tree", decoy, "-m", "decoy head"], top).trim();
  r.git(["replace", reviewed, decoy], top);
  r.git(["replace", head, fakeHead], top);
  // Control: plain git honours the replacements.
  assert.match(r.git(["ls-tree", "--name-only", reviewed], top), /decoy\.txt/);
  const log = join(r.tmp, "hook.log");
  mkdirSync(join(repo.gitDir, "hooks"), { recursive: true });
  const hook = join(repo.gitDir, "hooks", "pre-commit");
  writeFileSync(hook, `#!/bin/sh\n'${GIT}' diff --cached --name-only HEAD > '${log}' 2>&1\n`);
  chmodSync(hook, 0o755);

  const b = await begin(r, repo, { tree: reviewed });
  assert.equal(b.reply["t"], "scratch-ready");
  assert.equal(readFileSync(join(b.treeDir, "secret.txt"), "utf8"), "planted secret\n", "the fill wrote the real tree");
  assert.equal(existsSync(join(b.treeDir, "decoy.txt")), false);
  const spawned = await r.send({
    t: "hook", req: nextReq(), runId: "run-r", attempt: b.attempt, bind: { attempt: b.attempt, gitDir: repo.gitDir, index: 1 }, hook: "pre-commit", hookPath: hook,
    expectSha256: createHash("sha256").update(readFileSync(hook)).digest("hex"), env: { PATH: r.baseEnv["PATH"] as string, HOME: r.home, GIT_CONFIG_GLOBAL: r.globalConfig }, cols: 80, rows: 24,
  });
  assert.equal(spawned.t, "spawned");
  await r.exit(spawned.term as string);
  assert.equal(readFileSync(log, "utf8"), "secret.txt\n", "the hook's staged diff shows the planted file against the real HEAD");
  const v = await verifyAttempt(r, b.attempt);
  assert.deepEqual([v["staged"], v["files"]], [reviewed, "same"], "write-tree and the file walk compare against the real tree");
});
