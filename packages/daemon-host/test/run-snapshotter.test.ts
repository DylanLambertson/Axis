// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmodSync, cpSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { AxisError } from "@axis/audit";
import { resolveGit, type GitRunner } from "@axis/git-ops";
import { composeDaemonHost, createRunSnapshotter, SNAPSHOT_ATTEMPTS, SNAPSHOT_TAKE_MS, SUPERVISOR_SNAPSHOT_MS, type ComposeOptions, type SnapshotTaker, type PtyPort, type RunSnapshotterDeps, type RunSnapshotterFactory } from "../src/index.js";
import { createGitFixture, gitSkipReason, type GitFixture } from "../testing/git-fixture.js";
import { hostFixture } from "../testing/host-fixture.js";

// Ticket H13 (docs/design/git-snapshot.md section 8): the run snapshotter over `@axis/git-snapshot`, on a real repository.

// The port types through the host's own export (only src/bindings/*.ts of the host may import @axis/runs).
type RunSnapshotter = ReturnType<RunSnapshotterFactory>;
type SnapshotContext = Parameters<RunSnapshotter["before"]>[0];
const skip = gitSkipReason();
/** A directory symlink, or false where this system cannot make one (the case is then skipped, never passed). */
function link(target: string, at: string): boolean {
  try {
    symlinkSync(target, at, "dir");
    return true;
  } catch {
    return false;
  }
}
const reasonOf = (e: unknown): unknown => (e instanceof AxisError ? e.detail["reason"] : String(e));

describe("the run snapshotter over @axis/git-snapshot", { skip }, () => {
  let fx: GitFixture;
  let gitPath: string;
  let wt: { workTree: string; gitDir: string };
  let other: { workTree: string; gitDir: string };
  let n = 0;
  const ctx = (worktree = wt, workspaceId = `ws-${n + 1}`): SnapshotContext => ({ runId: `run-${++n}`, workspaceId, worktree });
  const make = (over: Partial<RunSnapshotterDeps> = {}, maxHeld?: number): RunSnapshotter => createRunSnapshotter({ gitPath, env: fx.env, projectRoot: () => fx.repo, ...over }, maxHeld);
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
    await assert.rejects(make().before(ctx(main)), (e) => reasonOf(e) === "common_dir_mismatch", "the main checkout is not a linked worktree");
    await assert.rejects(make({ projectRoot: () => undefined }).before(ctx()), (e) => reasonOf(e) === "project_unknown");
    await assert.rejects(make({ projectRoot: () => fx.root }).before(ctx()), (e) => reasonOf(e) === "common_dir_mismatch", "another repository's root");
  });

  test("a run that points commondir at a decoy is drift, and the next launch is refused, not baselined on the decoy (review B1)", async () => {
    const s = make();
    const decoy = join(fx.root, "decoy.git");
    cpSync(join(fx.repo, ".git"), decoy, { recursive: true });
    const file = join(wt.gitDir, "commondir");
    const saved = readFileSync(file);
    const run1 = ctx(wt, "ws-decoy");
    await s.before(run1);
    writeFileSync(file, `${decoy}\n`);
    try {
      assert.deepEqual(await s.after(run1), { drift: true });
      const run2 = ctx(wt, "ws-decoy");
      await assert.rejects(s.before(run2), (e) => reasonOf(e) === "snapshot_refused", "the decoy never becomes a baseline");
    } finally {
      writeFileSync(file, saved);
    }
    const run3 = ctx(wt, "ws-decoy");
    await s.before(run3);
    assert.deepEqual(await s.after(run3), { drift: false }, "restored, the worktree is judged again");
  });

  test("launches cancelled after before cannot push out another workspace's live baseline; a newer run replaces an older one", async () => {
    const s = make({}, 2);
    const live = ctx(wt, "ws-live");
    await s.before(live);
    for (let i = 0; i < 5; i++) await s.before(ctx(other, "ws-churn"));
    assert.deepEqual(await s.after(live), { drift: false });
    const older = ctx(wt, "ws-same");
    const newer = ctx(wt, "ws-same");
    await s.before(older);
    await s.before(newer);
    await assert.rejects(s.after(older), (e) => reasonOf(e) === "no_baseline", "only the workspace's latest run has a baseline");
    assert.deepEqual(await s.after(newer), { drift: false });
  });

  test("a stable snapshot fits inside the supervisor's bound with room to spawn git, and every take is given that bound", async () => {
    assert.ok(SNAPSHOT_TAKE_MS * SNAPSHOT_ATTEMPTS + 2000 <= SUPERVISOR_SNAPSHOT_MS, `${SNAPSHOT_TAKE_MS} x ${SNAPSHOT_ATTEMPTS} vs ${SUPERVISOR_SNAPSHOT_MS}`);
    const seen: Array<Parameters<SnapshotTaker>[0]> = [];
    const spy: SnapshotTaker = (opts) => (seen.push(opts), Promise.reject(new Error("stop here")));
    await assert.rejects(createRunSnapshotter({ gitPath, env: fx.env, projectRoot: () => fx.repo }, undefined, spy).before(ctx()));
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.attempts, SNAPSHOT_ATTEMPTS);
    assert.equal(seen[0]?.limits?.maxMillis, SNAPSHOT_TAKE_MS);
    assert.equal(seen[0]?.gitPath, gitPath);
    assert.equal(seen[0]?.expectedGitDir, wt.gitDir);
    assert.equal(seen[0]?.commonDir, realpathSync(join(fx.repo, ".git")));
  });

  test("the common dir is checked by structure before git is asked: project root and the worktrees/<name> position (review 2 N1)", async (t) => {
    assert.throws(() => make({ projectRoot: undefined as never }), (e) => reasonOf(e) === "snapshotter_required");
    await assert.rejects(make({ projectRoot: () => "repo" }).before(ctx()), (e) => reasonOf(e) === "project_unknown", "a relative root");
    // A git dir two levels below the common dir that is not under worktrees/ (refs/heads): refused by name, before any snapshot.
    await assert.rejects(make().before(ctx({ workTree: wt.workTree, gitDir: join(fx.repo, ".git", "refs", "heads") })), (e) => reasonOf(e) === "common_dir_mismatch");
    // A root reached through a symlinked directory is the same repository: accepted (the common dir is compared after realpath).
    const aliasRoot = join(fx.root, "alias-root");
    if (link(fx.repo, aliasRoot)) {
      const c = ctx();
      const s = make({ projectRoot: () => aliasRoot });
      await s.before(c);
      assert.deepEqual(await s.after(c), { drift: false });
    } else t.diagnostic("symlinks unavailable: alias root case skipped");
    // `<root>/.git` that is itself a symlink (not a real directory) is refused, even to the right place.
    const symGitRoot = join(fx.root, "sym-git-root");
    mkdirSync(symGitRoot);
    if (link(join(fx.repo, ".git"), join(symGitRoot, ".git"))) {
      await assert.rejects(make({ projectRoot: () => symGitRoot }).before(ctx()), (e) => reasonOf(e) === "common_dir_mismatch");
    } else t.diagnostic("symlinks unavailable: symlinked .git case skipped");
    // worktrees/<name> swapped for a symlink to a decoy's admin dir: its real path is not under the common dir.
    const wt3 = linked("wt3");
    const decoy = join(fx.root, "decoy3.git");
    cpSync(join(fx.repo, ".git"), decoy, { recursive: true });
    const admin = join(fx.repo, ".git", "worktrees", "wt3");
    rmSync(admin, { recursive: true, force: true });
    if (link(join(decoy, "worktrees", "wt3"), admin)) {
      await assert.rejects(make().before(ctx({ workTree: wt3.workTree, gitDir: admin })), (e) => reasonOf(e) === "common_dir_mismatch");
    } else t.diagnostic("symlinks unavailable: admin swap case skipped");
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
    const good = { before: () => Promise.resolve(), after: () => Promise.resolve({ drift: false }) };
    // The first instance (CLI runs) or the second (composer commands, C3) without its methods both refuse the start.
    const secondBad = (bad: unknown) => {
      let n = 0;
      return () => (n++ === 0 ? good : bad);
    };
    const factories = [{}, { before: () => Promise.resolve() }, undefined].flatMap((bad) => [() => bad, secondBad(bad)]);
    for (const factory of factories) {
      const fix = hostFixture();
      const composed = composeDaemonHost(options(fix, factory as never));
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
      assert.equal(calls.length, 2, "one for CLI runs, one for composer commands (C3)");
      for (const c of calls) {
        assert.equal(c.gitPath, services.gitPath, "the git resolved once at startup (design 5a)");
        assert.equal(c.env, fix.ports.env, "the host's environment copy");
      }
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
