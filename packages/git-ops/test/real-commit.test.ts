// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Real-git regression tests for the commit verification and its compare-and-swap undo.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GitOpsError, executeCommit, type GitOpsDeps, type GitRunRequest } from "../src/index.js";
import { fixture, stage, type Fixture } from "./realFixture.js";

async function failure(p: Promise<unknown>): Promise<GitOpsError> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof GitOpsError, String(e));
    return e;
  }
  assert.fail("expected a refusal");
}

/** Wraps the runner so `before` runs just before a request of the given kind, as a racing process would. */
function racing(f: Fixture, when: (req: GitRunRequest) => boolean, before: () => void): GitOpsDeps {
  const inner = f.deps.runner;
  return { ...f.deps, runner: { run: async (req) => { if (when(req)) before(); return inner.run(req); } } };
}

test("S-5: when the undo's compare-and-swap fails, the commit is NOT reported as undone and stays on the branch", async () => {
  const f = fixture();
  const reviewed = stage(f, "b.txt", "two\n");
  const deps = racing(f, (r) => r.context === "daemon" && r.argv.includes("update-ref"), () => f.git("commit", "-q", "--allow-empty", "-m", "moved"));
  // A pty-side change makes the committed tree differ from the reviewed one.
  const withChange = racing({ ...f, deps } as Fixture, (r) => r.context === "pty", () => { writeFileSync(join(f.wt.workTree, "c.txt"), "unreviewed\n"); f.git("add", "-A"); });
  const e = await failure(executeCommit(withChange, { worktree: f.wt, reviewedTreeHash: reviewed, message: "m" }));
  assert.equal(e.code, "E_INTERNAL");
  assert.deepEqual(e.details, { undone: false });
  assert.doesNotMatch(e.message, /was undone/);
  assert.ok(f.git("ls-tree", "--name-only", "HEAD~1").includes("c.txt"), "the unreviewed commit is still on the branch");
});

test("S-5: a tree mismatch is undone to the real parent, and the daemon's undo runs no reference-transaction hook", async () => {
  const f = fixture();
  // pre-commit (pty context, hooks on) sneaks an unreviewed file into the index; the post-check must catch it.
  const hook = join(f.wt.gitDir, "hooks", "pre-commit");
  mkdirSync(join(f.wt.gitDir, "hooks"), { recursive: true });
  writeFileSync(hook, `#!/bin/sh\necho sneaky > "${f.wt.workTree}/c.txt"\ngit add c.txt\n`);
  chmodSync(hook, 0o755);
  // Every event a hook-enabled ref update emits is logged. Which events, and how many, depends on the git version
  // (newer git adds "preparing" and "aborted"), so only the line COUNT around the daemon's undo is compared.
  const refTx = join(f.wt.gitDir, "hooks", "reference-transaction");
  writeFileSync(refTx, `#!/bin/sh\necho "$1" >> "${f.marker}"\n`);
  chmodSync(refTx, 0o755);
  const lines = (): number => (existsSync(f.marker) ? readFileSync(f.marker, "utf8").split("\n").filter(Boolean).length : 0);
  const around: Array<{ before: number; after: number }> = [];
  const inner = f.deps.runner;
  const deps: GitOpsDeps = {
    ...f.deps,
    runner: {
      run: async (req) => {
        if (req.context !== "daemon" || !req.argv.includes("update-ref")) return inner.run(req);
        const before = lines();
        const r = await inner.run(req);
        around.push({ before, after: lines() });
        return r;
      },
    },
  };
  const reviewed = stage(f, "b.txt", "two\n");
  const parent = f.git("rev-parse", "HEAD").trim();
  const e = await failure(executeCommit(deps, { worktree: f.wt, reviewedTreeHash: reviewed, message: "m" }));
  assert.equal(e.code, "E_CONFLICT");
  assert.deepEqual(e.details, { undone: true });
  assert.equal(f.git("rev-parse", "HEAD").trim(), parent, "the branch is back on the parent");
  assert.equal(around.length, 1, "the daemon ran exactly one update-ref, the undo");
  assert.ok((around[0] as { before: number }).before > 0, "the pty commit ran the hook, so the log is live");
  assert.equal((around[0] as { after: number }).after, (around[0] as { before: number }).before, "the daemon's undo invoked no hook");
  // Positive control: the same kind of update with hooks enabled DOES log, so the check above cannot pass vacuously.
  const before = lines();
  f.git("update-ref", "refs/heads/control", "HEAD");
  assert.ok(lines() > before, "a hook-enabled update-ref appends to the log on this git");
});

test("S-5: a commit built on a parent that moved during the commit is left in place and reported, not undone", async () => {
  const f = fixture();
  const reviewed = stage(f, "b.txt", "two\n");
  const deps = racing(f, (r) => r.context === "pty", () => {
    const x = f.git("commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "x").trim();
    f.git("update-ref", "refs/heads/axis/feat", x);
  });
  const e = await failure(executeCommit(deps, { worktree: f.wt, reviewedTreeHash: reviewed, message: "m" }));
  assert.equal(e.code, "E_INTERNAL");
  assert.deepEqual(e.details, { undone: false });
  assert.equal(f.git("log", "-1", "--format=%s", "HEAD~1").trim(), "x", "the commit that moved the branch is still there");
  assert.equal(f.git("log", "-1", "--format=%s").trim(), "m");
});

test("N-3: a shell profile's own GIT_AUTHOR_* that matches the config commits; one that differs is refused before git runs", async () => {
  const f0 = fixture();
  const pty = { ...f0.deps.env.pty, GIT_AUTHOR_NAME: "Dylan Lambertson", GIT_AUTHOR_EMAIL: "me@dylanlambertson.dev", GIT_COMMITTER_NAME: "Dylan Lambertson" };
  const f = fixture({ env: { daemon: f0.deps.env.daemon, pty } });
  const tree = stage(f, "b.txt", "two\n");
  await executeCommit(f.deps, { worktree: f.wt, reviewedTreeHash: tree, message: "m" });
  assert.equal(f.git("log", "-1", "--format=%an <%ae>").trim(), "Dylan Lambertson <me@dylanlambertson.dev>");
  const g = fixture({ env: { daemon: f0.deps.env.daemon, pty: { ...pty, GIT_AUTHOR_NAME: "Somebody Else" } } });
  const t2 = stage(g, "b.txt", "two\n");
  const e = await failure(executeCommit(g.deps, { worktree: g.wt, reviewedTreeHash: t2, message: "m" }));
  assert.equal(e.code, "E_POLICY_DENIED");
  assert.equal(g.seen.filter((r) => r.context === "pty").length, 0);
});
