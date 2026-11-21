// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { Redactor } from "@axis/audit";
import { resolveGit } from "@axis/git-ops";
import { COMPOSER_SNAPSHOT_TAKE_MS, RunWt2, SNAPSHOT_TAKE_MS, composerGuardDeps, createRunRepositoryGuard, parseHostConfig, type SnapshotTaker } from "../src/index.js";
import { snapshotLibraryForTests } from "../src/bindings/snapshot.js";
import { ComposerRunHalt } from "../src/ports/composer.js";
import { createGitFixture, gitSkipReason, type GitFixture } from "../testing/git-fixture.js";
import { validConfig } from "./helpers.js";
import { START } from "./composer-rig.js";
import { approveCommand, commandRig, eventually, fakeGuard, nodeRun } from "./composer-command-rig.js";

// C7-F2: a composer run's WT-2 check that could not judge the repository and saw no change in what it read is still drift and
// halts the run, with its own closed reason GIT_DRIFT_UNJUDGED; a change seen (also by takes that differed), a link mismatch,
// another unread item, a bad digest or a check that throws stays GIT_DRIFT. The take bound is a host limit, and the run's
// cancel stops a take (review c7-f2 r1).

const { take: takeStableSnapshot, digest: computeDigest } = snapshotLibraryForTests;
type Snapshot = Awaited<ReturnType<SnapshotTaker>>;
type Mode = "real" | "unfinished" | "stopped-short" | "unstable" | "mismatch" | "other-unread" | "bad-digest";

describe("the composer guard's verdicts and take bound", { skip: gitSkipReason() }, () => {
  let fx: GitFixture;
  let gitPath: string;
  let wt: { workTree: string; gitDir: string };
  const hook = () => join(fx.repo, ".git", "hooks", "post-checkout");
  before(() => {
    fx = createGitFixture();
    gitPath = resolveGit(fx.env, process.platform) ?? assert.fail("git");
    fx.git(fx.repo, "worktree", "add", "-q", join(fx.root, "wt"), "-b", "axis/wt");
    wt = { workTree: realpathSync(join(fx.root, "wt")), gitDir: realpathSync(join(fx.repo, ".git", "worktrees", "wt")) };
    mkdirSync(join(fx.repo, ".git", "hooks"), { recursive: true });
  });
  after(() => fx.cleanup());

  /** A real snapshot, reshaped into each kind of take that cannot be judged. */
  const shaped = (mode: { value: Mode }): SnapshotTaker => async (opts) => {
    const real = await takeStableSnapshot({ ...opts, limits: { ...opts.limits, maxMillis: 60_000 } });
    const item = (reason: string, id = "snapshot") => ({ id, reason, blocking: true });
    const reshape = (s: Snapshot, incomplete: Snapshot["incomplete"], link = s.link, entries = s.entries, digest?: string): Snapshot =>
      ({ ...s, entries, link, incomplete, digest: digest ?? computeDigest(entries, link, incomplete) }) as Snapshot;
    switch (mode.value) {
      case "real":
        return real;
      case "unfinished":
        return reshape(real, [...real.incomplete, item("stopped at the time limit")]);
      case "stopped-short": // a partial take that never reached its last entries: removals only
        return reshape(real, [...real.incomplete, item("stopped at the time limit")], real.link, real.entries.slice(0, -1));
      case "unstable":
        return reshape(real, [...real.incomplete, item("changed between consecutive snapshots")]);
      case "mismatch":
        return reshape(real, [...real.incomplete, item("stopped at the time limit")], { ...real.link, mismatch: true });
      case "other-unread": // a file the take could not read (an attacker's FIFO, an unreadable hook), next to a timeout
        return reshape(real, [...real.incomplete, item("stopped at the time limit"), item("could not read", "hooks")]);
      case "bad-digest":
        return reshape(real, [...real.incomplete, item("stopped at the time limit")], real.link, real.entries, "0".repeat(64));
    }
  };

  test("unjudged only when nothing was seen to change; every other refusal is a change seen", async () => {
    const mode = { value: "real" as Mode };
    const g = createRunRepositoryGuard({ gitPath, env: fx.env, projectRoot: () => fx.repo }, undefined, shaped(mode));
    await g.baseline({ runId: "r1", workspaceId: "w1", worktree: wt });
    assert.deepEqual(await g.check("r1"), { drift: false });
    for (const [m, expected] of [
      ["unfinished", { drift: true, unjudged: true }],
      ["stopped-short", { drift: true, unjudged: true }],
      ["unstable", { drift: true, unjudged: true }],
      ["mismatch", { drift: true }],
      ["other-unread", { drift: true }],
      ["bad-digest", { drift: true }],
    ] as const) {
      mode.value = m;
      assert.deepEqual(await g.check("r1"), expected, m);
    }
    // A planted hook seen by the take: a change, whatever else the take reports (unfinished or unstable).
    writeFileSync(hook(), "#!/bin/sh\n");
    try {
      for (const m of ["real", "unfinished", "unstable"] as const) {
        mode.value = m;
        assert.deepEqual(await g.check("r1"), { drift: true }, `hook + ${m}`);
      }
    } finally {
      rmSync(hook(), { force: true });
    }
  });

  test("a writer that keeps rewriting a planted hook is a change seen, not an unjudged take (review r1 SF-1)", async () => {
    const g = createRunRepositoryGuard({ gitPath, env: fx.env, projectRoot: () => fx.repo, takeMs: 60_000 });
    await g.baseline({ runId: "flip", workspaceId: "w1", worktree: wt });
    const code = `const fs=require("node:fs");let n=0;setInterval(()=>fs.writeFileSync(${JSON.stringify(hook())},"#!/bin/sh\\n# "+(n++)+"\\n"),1)`;
    const writer = spawn(process.execPath, ["-e", code], { stdio: "ignore" });
    try {
      await eventually(() => readdirSync(join(fx.repo, ".git", "hooks")).includes("post-checkout"));
      for (let i = 0; i < 3; i++) assert.deepEqual(await g.check("flip"), { drift: true }, `check ${i}`);
    } finally {
      writer.kill("SIGKILL");
      await new Promise((res) => writer.once("exit", res));
      rmSync(hook(), { force: true });
    }
  });

  test("the run's cancel stops a take: an aborted check rejects, never answers clean (review r1 SF-2)", async () => {
    const g = createRunRepositoryGuard({ gitPath, env: fx.env, projectRoot: () => fx.repo, takeMs: 60_000 });
    await g.baseline({ runId: "abort", workspaceId: "w1", worktree: wt });
    await assert.rejects(g.check("abort", AbortSignal.abort()));
    await assert.rejects(g.baseline({ runId: "abort-2", workspaceId: "w1", worktree: wt }, AbortSignal.abort()));
  });

  test("the take bound: longer than the CLI runs' by default, set by the host limit", async () => {
    assert.ok(COMPOSER_SNAPSHOT_TAKE_MS > SNAPSHOT_TAKE_MS);
    const seen: Array<{ ms: number | undefined; signal: boolean }> = [];
    const spy: SnapshotTaker = (opts) => (seen.push({ ms: opts.limits?.maxMillis, signal: opts.signal !== undefined }), Promise.reject(new Error("stop")));
    const base = { gitPath, env: fx.env, projectRoot: () => fx.repo };
    for (const limits of [{}, { composerSnapshotTakeMs: 25_000 }]) {
      await assert.rejects(createRunRepositoryGuard(composerGuardDeps(base, limits), undefined, spy).baseline({ runId: `r-${seen.length}`, workspaceId: "w", worktree: wt }, new AbortController().signal));
    }
    assert.deepEqual(seen, [{ ms: COMPOSER_SNAPSHOT_TAKE_MS, signal: true }, { ms: 25_000, signal: true }], "every take gets the bound and the run's signal");
    const config = (limits: unknown) => parseHostConfig(validConfig({ limits }), new Redactor());
    assert.equal(config({ composerSnapshotTakeMs: 25_000 }).limits.composerSnapshotTakeMs, 25_000);
    assert.throws(() => config({ composerSnapshotTakeMs: 500 }));
    assert.throws(() => config({ composerSnapshotTakeMs: 200_000 }));
  });
});

test("a check stopped by the run's cancel propagates the abort instead of halting; any other failure halts GIT_DRIFT", async () => {
  const guard = { baseline: async () => undefined, check: async () => Promise.reject(new Error("take stopped")), release: () => undefined };
  const make = () => new RunWt2({ runId: "r", workspaceId: "w", worktree: { workTree: "/w", gitDir: "/g" }, guard, writeLock: (_w, fn) => fn() });
  const cancelled = make();
  await cancelled.beforeCommand(new AbortController().signal); // the baseline
  await assert.rejects(cancelled.turn(AbortSignal.abort()), (e) => !(e instanceof ComposerRunHalt), "the user's cancel is not reported as a change");
  assert.equal(cancelled.halted, false);
  const failed = make();
  await failed.beforeCommand(new AbortController().signal);
  await assert.rejects(failed.turn(new AbortController().signal), (e) => e instanceof ComposerRunHalt && e.reason === "GIT_DRIFT");
});

test("a composer run halts GIT_DRIFT_UNJUDGED on an unjudged check and GIT_DRIFT on a change or a check that throws", async (t) => {
  for (const [verdict, reason] of [["unjudged", "GIT_DRIFT_UNJUDGED"], [true, "GIT_DRIFT"], ["throw", "GIT_DRIFT"]] as const) {
    const guard = fakeGuard({ verdict: () => verdict });
    const c = await commandRig(t, { replies: [nodeRun("1"), { kind: "text", text: "never" }], commandGuard: guard });
    const { run } = await c.service.start(START(c.workspaceId), new AbortController().signal);
    await approveCommand(c, run.runId);
    await eventually(() => !c.service.get(run.runId).live);
    assert.deepEqual([c.service.get(run.runId).state, c.service.get(run.runId).reason], ["FAILED", reason], String(verdict));
  }
});

test("only bindings/snapshot.ts holds the test export of the snapshot library; no other source file uses it (review r1 N-2)", () => {
  const src = new URL("../src/", import.meta.url);
  const files = (readdirSync(src, { recursive: true }) as string[]).filter((f) => f.endsWith(".js") && !f.endsWith("snapshot.js"));
  assert.ok(files.length > 20, "the compiled sources were found");
  for (const f of files) assert.ok(!readFileSync(new URL(f, src), "utf8").includes("snapshotLibraryForTests"), f);
});
