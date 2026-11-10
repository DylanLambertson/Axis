// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// H9-hooks §4.1 S1 tests of createPtyGitRunner with real git: git-ops' real commit requests, sent by the host's commit handler,
// run in the real pty service over the real host port. The journal's git directory is where the commit lands whatever the
// cwd (GIT-4), the commit encoding pin holds against the repository, and a gone pty process refuses the commit.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { GitRunRequest } from "@axis/git-ops";
import { gitRig, gitUnavailable, type GitClient, type GitRig } from "./git-rig.js";
import { ptyProcessRig, type PtyProcessRig } from "./pty-process-rig.js";

const SKIP = process.platform === "win32" ? "POSIX process groups are needed (the Windows path is unverified)" : gitUnavailable();

async function setup(t: TestContext): Promise<{ r: GitRig; c: GitClient; pty: PtyProcessRig; sent: GitRunRequest[] }> {
  let pty: PtyProcessRig | undefined;
  const sent: GitRunRequest[] = [];
  const r = await gitRig({
    ptyRunner: ({ home, gitPath, path }) => {
      pty = ptyProcessRig(gitPath, { PATH: path, HOME: home, GIT_CONFIG_NOSYSTEM: "1", LANG: "C" });
      const runner = pty.runner;
      return { run: (req) => (sent.push(req), runner.run(req)) };
    },
  });
  const p = pty as unknown as PtyProcessRig;
  t.after(() => (p.cleanup(), r.cleanup()));
  return { r, c: await r.connect("user"), pty: p, sent };
}

async function commitChange(r: GitRig, c: GitClient, content: string) {
  r.write("a.txt", content);
  const d = await c.rpc("axis.review", "diff", { workspaceId: r.workspaceId });
  assert.equal(d.ok, true, JSON.stringify(d.error));
  const { head, branch, treeHash } = d.result as { head: string; branch: string; treeHash: string };
  const res = await c.rpc("axis.git", "commit", { workspaceId: r.workspaceId, message: "add a", reviewedTreeHash: treeHash, expectedParent: head, expectedBranch: branch }, randomUUID());
  return { res, head, treeHash };
}

test("git-ops' real commit-tree and commit.gpgsign requests run in the pty process with the journal's --git-dir and --work-tree", { skip: SKIP ?? false }, async (t) => {
  const { r, c, pty, sent } = await setup(t);
  const { res, head, treeHash } = await commitChange(r, c, "one\n");
  assert.equal(res.ok, true, JSON.stringify(res.error));
  const sha = (res.result as { commit: string }).commit;
  assert.equal(r.head(), sha);
  assert.equal(r.git("rev-parse", `${sha}^{tree}`).trim(), treeHash);
  assert.equal(r.git("rev-parse", `${sha}^`).trim(), head);
  assert.deepEqual(sent.map((q) => q.argv.find((a) => a === "config" || a === "commit-tree")), ["config", "commit-tree"], "both pty requests went through the runner");
  const ran = pty.execs.filter((e) => e.argv.includes("commit-tree") || e.argv.includes("commit.gpgsign"));
  assert.equal(ran.length, 2);
  for (const e of ran) {
    assert.ok(e.argv.includes(`--git-dir=${join(r.repo, ".git")}`) && e.argv.includes(`--work-tree=${r.repo}`), e.argv.join(" "));
    assert.equal(e.env["GIT_DIR"], undefined);
  }
});

test("GIT-4: replayed with a cwd outside the worktree whose .git file points at another repository, the commit lands in the journal's git directory", { skip: SKIP ?? false }, async (t) => {
  const { r, c, pty, sent } = await setup(t);
  const { res } = await commitChange(r, c, "two\n");
  assert.equal(res.ok, true, JSON.stringify(res.error));
  const decoyRepo = join(r.root, "decoy-repo");
  execFileSync("git", ["init", "-q", decoyRepo], { env: r.genv, stdio: "ignore" });
  const decoy = join(r.root, "decoy");
  mkdirSync(decoy);
  writeFileSync(join(decoy, ".git"), `gitdir: ${join(decoyRepo, ".git")}\n`);
  const original = sent.find((q) => q.argv.includes("commit-tree")) as GitRunRequest;
  const out = await pty.runner.run({ ...original, cwd: decoy, stdin: "replayed\n" });
  assert.equal(out.code, 0);
  const id = out.stdout.trim();
  assert.match(id, /^[0-9a-f]{40,64}$/);
  assert.equal(r.git("cat-file", "-t", id).trim(), "commit", "the object is in the journal's git directory");
  assert.throws(() => execFileSync("git", ["cat-file", "-e", id], { cwd: decoyRepo, env: r.genv, stdio: "ignore" }), "and not in the repository the cwd points at");
});

test("a repository i18n.commitEncoding=latin1 does not change the recorded encoding: the commit has no encoding header", { skip: SKIP ?? false }, async (t) => {
  const { r, c } = await setup(t);
  r.git("config", "i18n.commitEncoding", "latin1");
  const { res } = await commitChange(r, c, "three\n");
  assert.equal(res.ok, true, JSON.stringify(res.error));
  const sha = (res.result as { commit: string }).commit;
  const raw = r.git("cat-file", "commit", sha);
  assert.doesNotMatch(raw.split("\n\n")[0] as string, /^encoding /m);
  // Control: the same commit-tree without the service's pin records the repository's encoding, so the check above can fail.
  const control = execFileSync("git", ["commit-tree", "-p", sha, "-m", "control", `${sha}^{tree}`], { cwd: r.repo, env: r.genv, encoding: "utf8" }).trim();
  assert.match(r.git("cat-file", "commit", control), /^encoding latin1$/m);
});

test("the pty process gone: the commit is refused E_UNAVAILABLE, nothing runs in the daemon and the branch does not move", { skip: SKIP ?? false }, async (t) => {
  const { r, c, pty, sent } = await setup(t);
  pty.close();
  const before = r.head();
  const { res } = await commitChange(r, c, "four\n");
  assert.equal(res.ok, false);
  assert.equal((res.error as { code: string }).code, "E_UNAVAILABLE");
  assert.equal(r.head(), before);
  assert.ok(sent.length >= 1, "the request reached the runner");
  assert.equal(pty.execs.filter((e) => e.argv.includes("commit-tree")).length, 0);
});
