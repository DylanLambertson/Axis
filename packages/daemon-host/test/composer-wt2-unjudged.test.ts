// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { resolveGit } from "@axis/git-ops";
import { COMPOSER_SNAPSHOT_TAKE_MS, SNAPSHOT_TAKE_MS, composerGuardDeps, createRunRepositoryGuard, parseHostConfig, type SnapshotTaker } from "../src/index.js";
import { snapshotLibraryForTests } from "../src/bindings/snapshot.js";

const { take: takeStableSnapshot, digest: computeDigest } = snapshotLibraryForTests;
type Snapshot = Awaited<ReturnType<SnapshotTaker>>;
import { Redactor } from "@axis/audit";
import { createGitFixture, gitSkipReason, type GitFixture } from "../testing/git-fixture.js";
import { validConfig } from "./helpers.js";
import { START } from "./composer-rig.js";
import { commandRig, eventually, fakeGuard, nodeRun, approveCommand } from "./composer-command-rig.js";

// C7-F2: a composer run's WT-2 check that could not finish (a snapshot stopped at its time bound, or one that kept changing) is
// still drift and halts the run, with its own closed reason GIT_DRIFT_UNJUDGED; a change seen, a link mismatch or a check that
// throws stays GIT_DRIFT. The composer guard's take bound is a host limit with a longer default than the CLI runs'.

type Mode = "real" | "unfinished" | "mismatch";

describe("the composer guard's verdicts and take bound", { skip: gitSkipReason() }, () => {
  let fx: GitFixture;
  let gitPath: string;
  let wt: { workTree: string; gitDir: string };
  before(() => {
    fx = createGitFixture();
    gitPath = resolveGit(fx.env, process.platform) ?? assert.fail("git");
    fx.git(fx.repo, "worktree", "add", "-q", join(fx.root, "wt"), "-b", "axis/wt");
    wt = { workTree: realpathSync(join(fx.root, "wt")), gitDir: realpathSync(join(fx.repo, ".git", "worktrees", "wt")) };
  });
  after(() => fx.cleanup());

  /** The real snapshot, made to look like one that stopped at its bound, or one whose worktree link does not match. */
  const shaped = (mode: { value: Mode }): SnapshotTaker => async (opts) => {
    const real = await takeStableSnapshot({ ...opts, limits: { ...opts.limits, maxMillis: 60_000 } });
    if (mode.value === "real") return real;
    const incomplete = [...real.incomplete, { id: "snapshot", reason: "stopped at the time limit", blocking: true }];
    const link = mode.value === "mismatch" ? { ...real.link, mismatch: true } : real.link;
    return { ...real, link, incomplete, digest: computeDigest(real.entries, link, incomplete) } as Snapshot;
  };

  test("only a snapshot that could not finish is unjudged; a link mismatch or a planted hook is a change seen", async () => {
    const mode = { value: "real" as Mode };
    const g = createRunRepositoryGuard({ gitPath, env: fx.env, projectRoot: () => fx.repo }, undefined, shaped(mode));
    await g.baseline({ runId: "r1", workspaceId: "w1", worktree: wt });
    assert.deepEqual(await g.check("r1"), { drift: false });
    mode.value = "unfinished";
    assert.deepEqual(await g.check("r1"), { drift: true, unjudged: true });
    mode.value = "mismatch";
    assert.deepEqual(await g.check("r1"), { drift: true }, "a link mismatch is never just 'could not finish'");
    mode.value = "real";
    mkdirSync(join(fx.repo, ".git", "hooks"), { recursive: true });
    writeFileSync(join(fx.repo, ".git", "hooks", "post-checkout"), "#!/bin/sh\n");
    try {
      assert.deepEqual(await g.check("r1"), { drift: true });
      // A take that stopped at its bound lacks entries, so its differences cannot be told from what it did not read: it is
      // unjudged even when it differs. Either way the run halts; only the reason's name differs.
      mode.value = "unfinished";
      assert.deepEqual(await g.check("r1"), { drift: true, unjudged: true });
    } finally {
      rmSync(join(fx.repo, ".git", "hooks", "post-checkout"));
    }
  });

  test("the take bound: longer than the CLI runs' by default, set by the host limit", async () => {
    assert.ok(COMPOSER_SNAPSHOT_TAKE_MS > SNAPSHOT_TAKE_MS);
    const seen: number[] = [];
    const spy: SnapshotTaker = (opts) => (seen.push(opts.limits?.maxMillis ?? -1), Promise.reject(new Error("stop")));
    const base = { gitPath, env: fx.env, projectRoot: () => fx.repo };
    for (const limits of [{}, { composerSnapshotTakeMs: 25_000 }]) {
      await assert.rejects(createRunRepositoryGuard(composerGuardDeps(base, limits), undefined, spy).baseline({ runId: `r-${seen.length}`, workspaceId: "w", worktree: wt }));
    }
    assert.deepEqual(seen, [COMPOSER_SNAPSHOT_TAKE_MS, 25_000]);
    const config = (limits: unknown) => parseHostConfig(validConfig({ limits }), new Redactor());
    assert.equal(config({ composerSnapshotTakeMs: 25_000 }).limits.composerSnapshotTakeMs, 25_000);
    assert.throws(() => config({ composerSnapshotTakeMs: 500 }));
    assert.throws(() => config({ composerSnapshotTakeMs: 200_000 }));
  });
});

test("a composer run halts GIT_DRIFT_UNJUDGED on an unfinished check and GIT_DRIFT on a change or a check that throws", async (t) => {
  for (const [verdict, reason] of [["unjudged", "GIT_DRIFT_UNJUDGED"], [true, "GIT_DRIFT"], ["throw", "GIT_DRIFT"]] as const) {
    const guard = fakeGuard({ verdict: () => verdict });
    const c = await commandRig(t, { replies: [nodeRun("1"), { kind: "text", text: "never" }], commandGuard: guard });
    const { run } = await c.service.start(START(c.workspaceId), new AbortController().signal);
    await approveCommand(c, run.runId);
    await eventually(() => !c.service.get(run.runId).live);
    assert.deepEqual([c.service.get(run.runId).state, c.service.get(run.runId).reason], ["FAILED", reason], String(verdict));
  }
});
