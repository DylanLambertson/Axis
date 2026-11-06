// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmodSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { AxisError } from "@axis/audit";
import { resolveGit, type GitRunner } from "@axis/git-ops";
import { composeDaemonHost, createRunSnapshotter, type ComposeOptions, type PtyPort, type RunSnapshotterDeps, type RunSnapshotterFactory } from "../src/index.js";
import { createGitFixture, gitSkipReason, type GitFixture } from "../testing/git-fixture.js";
import { hostFixture } from "../testing/host-fixture.js";

// Ticket H13 (docs/design/git-snapshot.md section 8): the run snapshotter over `@axis/git-snapshot`, on a real repository.

// The port types through the host's own export (only src/bindings/*.ts of the host may import @axis/runs).
type RunSnapshotter = ReturnType<RunSnapshotterFactory>;
type SnapshotContext = Parameters<RunSnapshotter["before"]>[0];
const skip = gitSkipReason();
const reasonOf = (e: unknown): unknown => (e instanceof AxisError ? e.detail["reason"] : String(e));

describe("the run snapshotter over @axis/git-snapshot", { skip }, () => {
  let fx: GitFixture;
  let gitPath: string;
  let wt: { workTree: string; gitDir: string };
  let other: { workTree: string; gitDir: string };
  let n = 0;
  const ctx = (worktree = wt): SnapshotContext => ({ runId: `run-${++n}`, workspaceId: "ws-1", worktree });
  const make = (over: Partial<RunSnapshotterDeps> = {}, maxHeld?: number): RunSnapshotter => createRunSnapshotter({ gitPath, env: fx.env, ...over }, maxHeld);
  const linked = (name: string): { workTree: string; gitDir: string } => {
    fx.git(fx.repo, "worktree", "add", "-q", join(fx.root, name), "-b", `axis/${name}`);
    return { workTree: realpathSync(join(fx.root, name)), gitDir: realpathSync(join(fx.repo, ".git", "worktrees", name)) };
  };

  before(() => {
    fx = createGitFixture();
    gitPath = resolveGit(fx.env, process.platform) ?? assert.fail("git");
    wt = linked("wt");
    other = linked("wt2");
  });
  after(() => fx.cleanup());

  test("a run that only writes work files is no drift; the held snapshot is used once", async () => {
    const s = make();
    const c = ctx();
    await s.before(c);
    writeFileSync(join(wt.workTree, "work.txt"), "work\n");
    assert.deepEqual(await s.after(c), { drift: false });
    await assert.rejects(s.after(c), (e) => reasonOf(e) === "no_baseline", "a second after has no baseline: never 'no drift'");
  });

  test("a hook planted in the common dir and a config change are drift", async () => {
    const s = make();
    const c1 = ctx();
    await s.before(c1);
    const hook = join(fx.repo, ".git", "hooks", "post-checkout");
    writeFileSync(hook, "#!/bin/sh\nexit 0\n");
    chmodSync(hook, 0o755);
    assert.deepEqual(await s.after(c1), { drift: true });
    const c2 = ctx();
    await s.before(c2);
    fx.git(fx.repo, "config", "core.fsmonitor", "true");
    assert.deepEqual(await s.after(c2), { drift: true });
  });

  test("a run that re-points the worktree's .git is drift; a before on a git dir that is not the worktree's refuses the launch", async () => {
    const s = make();
    const c = ctx();
    await s.before(c);
    const dotGit = join(wt.workTree, ".git");
    const saved = readFileSync(dotGit);
    writeFileSync(dotGit, `gitdir: ${other.gitDir}\n`);
    try {
      assert.deepEqual(await s.after(c), { drift: true }, "a link mismatch is refused, and refused is drift");
    } finally {
      writeFileSync(dotGit, saved);
    }
    const crossed = ctx({ workTree: wt.workTree, gitDir: other.gitDir });
    await assert.rejects(s.before(crossed), (e) => reasonOf(e) === "snapshot_refused");
    await assert.rejects(s.after(crossed), (e) => reasonOf(e) === "no_baseline", "a refused before holds nothing");
  });

  test("after without before throws, and the oldest held snapshot is evicted at the bound", async () => {
    await assert.rejects(make().after(ctx()), (e) => reasonOf(e) === "no_baseline");
    const s = make({}, 2);
    const [a, b, c] = [ctx(), ctx(), ctx()];
    for (const x of [a, b, c]) await s.before(x);
    await assert.rejects(s.after(a), (e) => reasonOf(e) === "no_baseline", "the oldest went first");
    assert.deepEqual(await s.after(c), { drift: false });
    assert.deepEqual(await s.after(b), { drift: false });
  });

  test("only the host's git is run, and only a linked worktree's git dir is accepted", async () => {
    await assert.rejects(make({ gitPath: join(fx.root, "no-such-git") }).before(ctx()), "a git path that is not there is not replaced by a PATH lookup");
    assert.throws(() => make({ gitPath: "git" }), (e) => reasonOf(e) === "snapshotter_required");
    const main = { workTree: realpathSync(fx.repo), gitDir: realpathSync(join(fx.repo, ".git")) };
    await assert.rejects(make().before(ctx(main)), (e) => reasonOf(e) === "commondir_unreadable");
  });
});

describe("the composition and the entry require the real snapshotter", () => {
  const pty: PtyPort = { spawn: () => Promise.reject(new Error("unused")) };
  const runner: GitRunner = { run: () => Promise.reject(new Error("unused")) };
  const options = (fix: ReturnType<typeof hostFixture>, snapshotter: ComposeOptions["snapshotter"]): ComposeOptions => {
    const { control: _control, ...ports } = fix.ports as typeof fix.ports & { control: unknown };
    return { config: fix.config, control: fix.client, ports, pty, ptyGitRunner: runner, snapshotter, process: new EventEmitter(), exit: () => undefined };
  };

  test("a snapshotter object instead of a factory is refused before storage", () => {
    const fix = hostFixture();
    try {
      const object = { before: () => Promise.resolve(), after: () => Promise.resolve({ drift: false }) };
      assert.throws(() => composeDaemonHost(options(fix, object as never)), (e) => reasonOf(e) === "snapshotter_required");
    } finally {
      fix.cleanup();
    }
  });

  test("start is refused when the factory gives no snapshotter, and the factory gets the host's one git", async () => {
    for (const bad of [{}, { before: () => Promise.resolve() }, undefined]) {
      const fix = hostFixture();
      const composed = composeDaemonHost(options(fix, () => bad as never));
      try {
        // After the lock every step error is reported as `startup_step` with the step's own reason kept.
        await assert.rejects(composed.start(), (e) => reasonOf(e) === "startup_step" && (e as AxisError).detail["causeReason"] === "snapshotter_required");
        assert.equal(composed.host.state, "stopped", "nothing is served after the refusal");
      } finally {
        await composed.stop();
        fix.cleanup();
      }
    }
    const fix = hostFixture();
    const calls: RunSnapshotterDeps[] = [];
    const composed = composeDaemonHost(options(fix, (deps) => (calls.push(deps), { before: () => Promise.resolve(), after: () => Promise.resolve({ drift: false }) })));
    try {
      const services = await composed.start();
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.gitPath, services.gitPath, "the git resolved once at startup (design 5a)");
      assert.equal(calls[0]?.env, fix.ports.env, "the host's environment copy");
    } finally {
      await composed.stop();
      fix.cleanup();
    }
  });

  test("the process entry passes the real factory, not a port", () => {
    const entry = readFileSync(new URL("../src/entry.js", import.meta.url), "utf8");
    assert.equal(entry.match(/snapshotter: gitSnapshotRunSnapshotter\b/g)?.length, 1);
    assert.equal(/ports\?*\.snapshotter/.test(entry), false);
  });
});
