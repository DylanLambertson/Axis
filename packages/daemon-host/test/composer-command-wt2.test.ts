// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { appendFileSync, existsSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { resolveGit } from "@axis/git-ops";
import { createRunRepositoryGuard } from "../src/index.js";
import { createGitFixture, gitSkipReason, type GitFixture } from "../testing/git-fixture.js";
import { START } from "./composer-rig.js";
import { answerPending, approvalsOf, approveCommand, commandRig, eventually, nodeRun, posix, toolsOf } from "./composer-command-rig.js";

// Ticket C3, WT-2 broker side, on a real repository: GIT-SNAP-1 (`createRunRepositoryGuard`, the host's own) takes one baseline
// at a composer run's first command and compares with it around every command, before every turn and at the end. A hook
// planted or a common dir config changed at any point of the run halts it.

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
  // The host's guard, with room for a slow snapshot: on a loaded machine (a full gate) a take can pass the host's 3 s and would
  // refuse the first command (`git_drift`) before anything this file tests happens.
  const guard = () => createRunRepositoryGuard({ gitPath, env: fx.env, projectRoot: () => fx.repo, takeMs: 60_000 });

  test("a command that only writes work files is no drift: the run goes on", async (t) => {
    const worktree = linked();
    const c = await commandRig(t, { worktree, replies: [nodeRun(write("work.txt", "work\n")), TEXT], commandGuard: guard() });
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
    const c = await commandRig(t, { worktree, replies: [nodeRun(write(hook, "#!/bin/sh\nexit 0\n")), nodeRun(write("after.txt", "x")), TEXT], commandGuard: guard() });
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
    const c = await commandRig(t, { worktree, replies: [nodeRun(write(config, `\n[core]\n\thooksPath = ${worktree.workTree}\n`)), TEXT], commandGuard: guard() });
    const { run } = await c.service.start(START(c.workspaceId), new AbortController().signal);
    await approveCommand(c, run.runId);
    await eventually(() => !c.service.get(run.runId).live);
    assert.deepEqual([c.service.get(run.runId).state, c.service.get(run.runId).reason], ["FAILED", "GIT_DRIFT"]);
  });

  test("review c3 r1 SF-1 (PROBE5): a detached child of one command plants a hook between commands; the next command never runs", { skip: !posix }, async (t) => {
    const worktree = linked();
    const hook = join(realpathSync(join(fx.repo, ".git")), "hooks", `post-checkout-${n}`);
    const [go, done, stop] = [join(fx.root, `go-${n}`), join(fx.root, `done-${n}`), join(fx.root, `stop-${n}`)];
    t.after(() => writeFileSync(stop, ""));
    // The child leaves the command's process group (the runner's kill cannot reach it) and writes only once told to. It waits on
    // the go (or the stop) file, not on a time: a loaded machine can take long between the commands. The count is a backstop only.
    const child = `const fs = require("fs"); let i = 0; const tick = () => { if (fs.existsSync(${JSON.stringify(go)})) { fs.appendFileSync(${JSON.stringify(hook)}, "#!/bin/sh\\nexit 0\\n"); fs.writeFileSync(${JSON.stringify(done)}, ""); } else if (!fs.existsSync(${JSON.stringify(stop)}) && ++i < 60000) setTimeout(tick, 10); }; tick();`;
    // The child's code is a file, so the command line names one path however long the temporary directory is (MAX_ARGV_JSON).
    const script = join(fx.root, `child-${n}.js`);
    writeFileSync(script, child);
    const spawner = `require("child_process").spawn(process.execPath, [${JSON.stringify(script)}], { detached: true, stdio: "ignore" }).unref()`;
    const c = await commandRig(t, { worktree, replies: [nodeRun(spawner), nodeRun(write("after.txt", "x")), TEXT], commandGuard: guard() });
    const { run } = await c.service.start(START(c.workspaceId), new AbortController().signal);
    await approveCommand(c, run.runId);
    // Command 2 waits for its approval: command 1, its check and the turn's check are done, command 2's own check is not. The
    // hook lands now. Nothing blocks the daemon's thread while the child writes (a blocked thread let the client's own
    // deadline run out on a loaded machine).
    const asked = (): number => approvalsOf(c, run.runId).filter((e) => e.state === "requested").length;
    await eventually(() => asked() === 2 || !c.service.get(run.runId).live, 6000);
    assert.deepEqual(toolsOf(c, run.runId).map((e) => e.outcome), ["ok"], `command 1 ended before the hook lands: ${JSON.stringify(toolsOf(c, run.runId).map((e) => e.reason))}`);
    writeFileSync(go, "");
    await eventually(() => existsSync(done), 6000);
    await answerPending(c);
    await eventually(() => !c.service.get(run.runId).live);
    assert.ok(existsSync(hook), "the detached child planted the hook after command 1 ended");
    assert.deepEqual([c.service.get(run.runId).state, c.service.get(run.runId).reason], ["FAILED", "GIT_DRIFT"]);
    assert.equal(existsSync(join(worktree.workTree, "after.txt")), false, "the next command's check compares with the run's first baseline");
  });

  test("a change after the last command (before the run ends) still fails the run (GIT_DRIFT), never REVIEWING", async (t) => {
    const worktree = linked();
    const config = join(realpathSync(join(fx.repo, ".git")), "config");
    const onRequest = (k: number): void => void (k === 2 && appendFileSync(config, `\n[core]\n\thooksPath = ${worktree.workTree}\n`));
    const c = await commandRig(t, { worktree, replies: [nodeRun(write("work.txt", "work\n")), TEXT], commandGuard: guard(), onRequest });
    const { run } = await c.service.start(START(c.workspaceId), new AbortController().signal);
    await approveCommand(c, run.runId);
    await eventually(() => !c.service.get(run.runId).live);
    assert.equal(toolsOf(c, run.runId)[0]?.outcome, "ok");
    assert.deepEqual([c.service.get(run.runId).state, c.service.get(run.runId).reason], ["FAILED", "GIT_DRIFT"]);
  });

  test("the guard holds one baseline per run: a second baseline is refused, a check keeps it, a release drops it", async () => {
    const worktree = linked();
    const g = guard();
    const ctx = { runId: "r-guard", workspaceId: "w", worktree };
    await g.baseline(ctx);
    await assert.rejects(g.baseline(ctx), "a run's baseline is never replaced");
    assert.deepEqual(await g.check("r-guard"), { drift: false });
    assert.deepEqual(await g.check("r-guard"), { drift: false }, "a check keeps the baseline");
    await assert.rejects(g.check("other-run"), "no baseline for another run");
    g.release("r-guard");
    await assert.rejects(g.check("r-guard"), "released at the run's end");
  });
});
