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
type Mode = "real" | "unfinished" | "stopped-short" | "stopped-many" | "unstable" | "unstable-short" | "ref-added" | "ref-changed" | "setting-added" | "mismatch" | "other-unread" | "bad-digest";

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
  const HELD: [string, string] = ["refs/heads/held", "a".repeat(40)];
  const shaped = (mode: { value: Mode }): SnapshotTaker => async (opts) => {
    const taken = await takeStableSnapshot({ ...opts, limits: { ...opts.limits, maxMillis: 60_000 } });
    // Every shaped take (the baseline too) holds one ref, so a moved ref has something to move (refs are not in the digest).
    const real = { ...taken, refs: [...taken.refs, HELD] } as Snapshot;
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
      case "stopped-many": // a stopped take that missed more entries than the diff lists (it is cut short)
        return reshape(real, [...real.incomplete, item("stopped at the time limit")], real.link, real.entries.slice(0, -600));
      case "ref-added": // a ref, a moved ref or a setting the stopped take did read: changes, not removals
        return { ...reshape(real, [...real.incomplete, item("stopped at the time limit")]), refs: [...real.refs, ["refs/heads/planted", "a".repeat(40)]] } as Snapshot;
      case "ref-changed":
        return { ...reshape(real, [...real.incomplete, item("stopped at the time limit")]), refs: real.refs.map(([n, v]) => (n === HELD[0] ? [n, "b".repeat(40)] : [n, v])) } as Snapshot;
      case "setting-added": {
        const planted = { key: "core.hookspath", value: "/planted/hooks", origin: "file:config", label: "hooks path", severity: "high", note: null };
        return { ...reshape(real, [...real.incomplete, item("stopped at the time limit")]), settings: [...real.settings, planted] } as Snapshot;
      }
      case "unstable": // two complete takes that differed: a writer, whatever the last one shows
        return reshape(real, [...real.incomplete, item("changed between consecutive snapshots")]);
      case "unstable-short":
        return reshape(real, [...real.incomplete, item("changed between consecutive snapshots")], real.link, real.entries.slice(0, -1));
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
      ["unstable", { drift: true }],
      ["unstable-short", { drift: true }],
      ["ref-added", { drift: true }],
      ["ref-changed", { drift: true }],
      ["setting-added", { drift: true }],
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

  test("a diff cut short is never unjudged: what it did not list may be a change (review r2 SF-A)", async () => {
    const many = join(fx.repo, ".git", "hooks", "many");
    mkdirSync(many, { recursive: true });
    for (let i = 0; i < 700; i++) writeFileSync(join(many, `n${String(i).padStart(4, "0")}.sample`), "x");
    try {
      const mode = { value: "real" as Mode };
      const g = createRunRepositoryGuard({ gitPath, env: fx.env, projectRoot: () => fx.repo }, undefined, shaped(mode));
      await g.baseline({ runId: "many", workspaceId: "w1", worktree: wt });
      mode.value = "stopped-many";
      assert.deepEqual(await g.check("many"), { drift: true });
    } finally {
      rmSync(many, { recursive: true, force: true });
    }
  });

  test("a writer that plants and removes a hook in turn is a change seen, never unjudged (review r2 SF-A)", async () => {
    const g = createRunRepositoryGuard({ gitPath, env: fx.env, projectRoot: () => fx.repo, takeMs: 60_000 });
    await g.baseline({ runId: "toggle", workspaceId: "w1", worktree: wt });
    const code = `const fs=require("node:fs");const p=${JSON.stringify(hook())};let on=false;setInterval(()=>{on=!on;try{on?fs.writeFileSync(p,"#!/bin/sh\\n"):fs.unlinkSync(p)}catch{}},1)`;
    const writer = spawn(process.execPath, ["-e", code], { stdio: "ignore" });
    try {
      for (let i = 0; i < 10; i++) {
        const r = await g.check("toggle");
        assert.notEqual(r.unjudged, true, `check ${i}: a writer is never 'could not judge'`);
      }
    } finally {
      writer.kill("SIGKILL");
      await new Promise((res) => writer.once("exit", res));
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

test("the command's own signal reaches its checks: a cancel during the command stops the check after it (review r2 SF-B)", async (t) => {
  const seen: boolean[] = [];
  const base = fakeGuard();
  const guard = { ...base, check: async (runId: string, signal?: AbortSignal) => (seen.push(signal?.aborted === true), base.check(runId)) };
  const c = await commandRig(t, { replies: [nodeRun("setTimeout(() => {}, 120000)"), { kind: "text", text: "never" }], commandGuard: guard });
  const { run } = await c.service.start(START(c.workspaceId), new AbortController().signal);
  await approveCommand(c, run.runId);
  await eventually(() => base.calls.some((x) => x.startsWith("baseline:")));
  c.service.cancel(run.runId);
  await eventually(() => !c.service.get(run.runId).live);
  assert.equal(c.service.get(run.runId).state, "CANCELLED");
  assert.ok(seen.includes(true), `the check after the cancelled command saw the cancel (${JSON.stringify(seen)})`);
});

test("the check before a command also gets the command's signal: a cancel stops a check that would never end (review r2 SF-B)", async (t) => {
  const base = fakeGuard();
  let checks = 0;
  let stoppedBy = "";
  // Ends the hung check if the signal never does, so a failing run still cleans up instead of hanging the file.
  const release = new AbortController();
  const guard = {
    ...base,
    // The third check is the one before the second command: it ends only when its signal aborts.
    check: async (runId: string, signal?: AbortSignal) =>
      ++checks < 3
        ? base.check(runId)
        : new Promise<never>((_res, rej) => {
            const stop = (by: string) => () => { stoppedBy ||= by; rej(new Error("stopped")); };
            signal?.addEventListener("abort", stop("signal"), { once: true });
            release.signal.addEventListener("abort", stop("release"), { once: true });
          }),
  };
  const c = await commandRig(t, { replies: [nodeRun("1"), nodeRun("2"), { kind: "text", text: "never" }], commandGuard: guard });
  const { run } = await c.service.start(START(c.workspaceId), new AbortController().signal);
  try {
    await approveCommand(c, run.runId);
    await approveCommand(c, run.runId);
    await eventually(() => checks >= 3);
    c.service.cancel(run.runId);
    await eventually(() => !c.service.get(run.runId).live, 500);
  } finally {
    release.abort();
  }
  assert.equal(stoppedBy, "signal", "the cancel reached the check before the command");
  await eventually(() => !c.service.get(run.runId).live);
  assert.equal(c.service.get(run.runId).state, "CANCELLED");
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
  const files = (readdirSync(src, { recursive: true }) as string[]).filter((f) => f.endsWith(".js") && f.replace(/\\/g, "/") !== "bindings/snapshot.js");
  assert.ok(files.length > 20, "the compiled sources were found");
  for (const f of files) assert.ok(!readFileSync(new URL(f, src), "utf8").includes("snapshotLibraryForTests"), f);
});
