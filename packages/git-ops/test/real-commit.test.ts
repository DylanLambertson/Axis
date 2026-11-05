// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Real-git tests for the identity rules of the commit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { GitOpsError, executeCommit } from "../src/index.js";
import { fixture, pin, stage } from "./realFixture.js";

async function failure(p: Promise<unknown>): Promise<GitOpsError> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof GitOpsError, String(e));
    return e;
  }
  assert.fail("expected a refusal");
}

test("N-3: a shell profile's own GIT_AUTHOR_* that matches the config commits; one that differs is refused before git runs", async () => {
  const f0 = fixture();
  const pty = { ...f0.deps.env.pty, GIT_AUTHOR_NAME: "Dylan Lambertson", GIT_AUTHOR_EMAIL: "me@dylanlambertson.dev", GIT_COMMITTER_NAME: "Dylan Lambertson" };
  const f = fixture({ env: { daemon: f0.deps.env.daemon, pty } });
  const tree = stage(f, "b.txt", "two\n");
  await executeCommit(f.deps, { worktree: f.wt, reviewedTreeHash: tree, message: "m", ...pin(f) });
  assert.equal(f.git("log", "-1", "--format=%an <%ae>").trim(), "Dylan Lambertson <me@dylanlambertson.dev>");
  const g = fixture({ env: { daemon: f0.deps.env.daemon, pty: { ...pty, GIT_AUTHOR_NAME: "Somebody Else" } } });
  const t2 = stage(g, "b.txt", "two\n");
  const e = await failure(executeCommit(g.deps, { worktree: g.wt, reviewedTreeHash: t2, message: "m", ...pin(g) }));
  assert.equal(e.code, "E_POLICY_DENIED");
  assert.equal(g.seen.filter((r) => r.context === "pty").length, 0);
});
