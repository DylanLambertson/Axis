// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { resolveGit } from "@axis/git-ops";
import { createRunSnapshotter } from "../src/index.js";
import { createGitFixture, gitSkipReason, type GitFixture } from "../testing/git-fixture.js";
import { START } from "./composer-rig.js";
import { approveCommand, commandRig, eventually, nodeRun, toolsOf } from "./composer-command-rig.js";

// Ticket C3, WT-2 broker side, on a real repository: GIT-SNAP-1 (`createRunSnapshotter`, the host's own) before and after
// every command of a composer run. A command that plants a hook or changes the common dir's config halts the run.

const TEXT = { kind: "text", text: "done" } as const;
const write = (path: string, text: string): string => `require("fs").appendFileSync(${JSON.stringify(path)}, ${JSON.stringify(text)})`;

describe("C3 WT-2 on a real repository", { skip: gitSkipReason() }, () => {
  let fx: GitFixture;
  let gitPath: string;
  let n = 0;
  before(() => {
    fx = createGitFixture();
    gitPath = resolveGit(fx.env, process.platform) ?? assert.fail("git");
  });
  after(() => fx.cleanup());

  /** A fresh linked worktree of the fixture repository, so the cases do not share a working tree. */
  const linked = (): { workTree: string; gitDir: string } => {
    const name = `c3-${++n}`;
    fx.git(fx.repo, "worktree", "add", "-q", join(fx.root, name), "-b", `axis/${name}`);
    return { workTree: realpathSync(join(fx.root, name)), gitDir: realpathSync(join(fx.repo, ".git", "worktrees", name)) };
  };
  const snapshotter = () => createRunSnapshotter({ gitPath, env: fx.env, projectRoot: () => fx.repo });

  test("a command that only writes work files is no drift: the run goes on", async (t) => {
    const worktree = linked();
    const c = await commandRig(t, { worktree, replies: [nodeRun(write("work.txt", "work\n")), TEXT], commandSnapshotter: snapshotter() });
    const { run } = await c.service.start(START(c.workspaceId), new AbortController().signal);
    await approveCommand(c, run.runId);
    await eventually(() => !c.service.get(run.runId).live);
    assert.equal(toolsOf(c, run.runId)[0]?.outcome, "ok");
    assert.equal(c.service.get(run.runId).state, "REVIEWING");
    assert.ok(existsSync(join(worktree.workTree, "work.txt")));
  });

  test("a command that plants a hook in the common dir halts the run (GIT_DRIFT)", async (t) => {
    const worktree = linked();
    const hook = join(realpathSync(join(fx.repo, ".git")), "hooks", `post-checkout-${n}`);
    const c = await commandRig(t, { worktree, replies: [nodeRun(write(hook, "#!/bin/sh\nexit 0\n")), nodeRun(write("after.txt", "x")), TEXT], commandSnapshotter: snapshotter() });
    const { run } = await c.service.start(START(c.workspaceId), new AbortController().signal);
    await approveCommand(c, run.runId);
    await eventually(() => !c.service.get(run.runId).live);
    assert.ok(existsSync(hook), "the command ran (the approval is the gate; WT-2 catches what it did)");
    assert.deepEqual([c.service.get(run.runId).state, c.service.get(run.runId).reason], ["FAILED", "GIT_DRIFT"]);
    assert.equal(existsSync(join(worktree.workTree, "after.txt")), false, "nothing of the run runs after the drift");
  });

  test("a command that changes the common dir's config halts the run (GIT_DRIFT)", async (t) => {
    const worktree = linked();
    const config = join(realpathSync(join(fx.repo, ".git")), "config");
    const c = await commandRig(t, { worktree, replies: [nodeRun(write(config, `\n[core]\n\thooksPath = ${worktree.workTree}\n`)), TEXT], commandSnapshotter: snapshotter() });
    const { run } = await c.service.start(START(c.workspaceId), new AbortController().signal);
    await approveCommand(c, run.runId);
    await eventually(() => !c.service.get(run.runId).live);
    assert.deepEqual([c.service.get(run.runId).state, c.service.get(run.runId).reason], ["FAILED", "GIT_DRIFT"]);
  });
});
