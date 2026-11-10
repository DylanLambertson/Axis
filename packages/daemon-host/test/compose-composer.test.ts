// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { test } from "node:test";
import type { GitRunner } from "@axis/git-ops";
import { composeDaemonHost, createAuditSeal, settleComposer, type ComposeOptions, type PtyPort } from "../src/index.js";
import { hostFixture } from "../testing/host-fixture.js";
import { must, trackTimers } from "./helpers.js";

// Review r1 S1 and S3: the composition's composer steps at startup (recovery) and at the final anchor (settle, then seal).

const pty: PtyPort = { spawn: () => Promise.reject(new Error("unused")) };
const runner: GitRunner = { run: () => Promise.reject(new Error("unused")) };
const snapshotter: NonNullable<ComposeOptions["snapshotter"]> = () => ({ before: () => Promise.resolve(), after: () => Promise.resolve({ drift: false }) });

function options(fix: ReturnType<typeof hostFixture>, over: Partial<ComposeOptions> = {}): ComposeOptions {
  const { control: _control, ...ports } = fix.ports as typeof fix.ports & { control: unknown };
  return { config: fix.config, control: fix.client, ports, pty, ptyGitRunner: runner, snapshotter, process: new EventEmitter(), exit: () => undefined, ...over };
}

test("N1 (review r2): after the final anchor both composed audit writers refuse a row; before it both write", async () => {
  const fix = hostFixture();
  const proc = new EventEmitter();
  let writers: Parameters<NonNullable<ComposeOptions["observeSealedWriters"]>>[0] | undefined;
  const composed = composeDaemonHost(options(fix, { process: proc, observeSealedWriters: (w) => void (writers = w) }));
  const row = (n: number) => ({ actor: "daemon", action: "tier4.challenge", target: `sha256:${n}`, outcome: "success", payload: { phase: "probe" } }) as never;
  try {
    const s = await composed.start();
    const w = must(writers);
    w.challenge.append(row(1));
    w.composer.append(row(2));
    const head = s.auditRead.head()?.seq ?? 0;
    proc.emit("SIGTERM");
    await composed.finished;
    const sealed = (e: unknown): boolean => (e as { code?: string; detail?: Record<string, unknown> }).code === "E_UNAVAILABLE" && (e as { detail: Record<string, unknown> }).detail["reason"] === "audit_sealed";
    assert.throws(() => w.challenge.append(row(3)), sealed, "the challenge writer is sealed");
    assert.throws(() => w.composer.append(row(4)), sealed, "the composer writer is sealed");
    assert.ok(head >= 2, "both writers wrote before the shutdown");
  } finally {
    await composed.stop();
    fix.cleanup();
  }
});

test("startup cancels a composer run that was QUEUED when the host died, and leaves a CLI run to the run supervisor's rules", async () => {
  const first = hostFixture();
  let composerRun = "";
  let otherRun = "";
  const a = composeDaemonHost(options(first));
  try {
    const s = await a.start();
    const journal = must(s.journal);
    const ws = journal.createWorkspace({ projectId: "p", branch: "axis/x", baseRef: "main", baseSha: "b".repeat(40), createdBy: "user" }).value;
    journal.transitionWorkspace(ws.id, "READY");
    composerRun = journal.createRun({ workspaceId: ws.id, kind: "composer", createdBy: "user" }).value.id;
    otherRun = journal.createRun({ workspaceId: ws.id, kind: "cli", createdBy: "user" }).value.id;
  } finally {
    await a.stop();
  }
  const second = hostFixture({ config: { dataDir: first.dataDir, worktreeRoot: join(first.dataDir, "..", "worktrees") } });
  second.supervisor.anchor = first.supervisor.anchor;
  const b = composeDaemonHost(options(second));
  try {
    const s = await b.start();
    assert.equal(s.degraded, undefined);
    const run = must(s.journal).getRun(composerRun);
    assert.deepEqual([run?.state, run?.reason], ["CANCELLED", "INTERRUPTED_BY_RESTART"]);
    const transitions = must(s.journal).transitions("run", composerRun).map((t) => `${t.to}:${t.actor}`);
    assert.deepEqual(transitions, ["QUEUED:user", "CANCELLED:daemon"]);
    assert.notEqual(must(s.journal).getRun(otherRun), undefined);
  } finally {
    await b.stop();
    first.cleanup();
    second.cleanup();
  }
});

test("settleComposer: loops are stopped, a settled service is awaited, and only then are the writers sealed", async () => {
  const seal = createAuditSeal();
  const order: string[] = [];
  let release!: () => void;
  const idle = new Promise<void>((r) => (release = r));
  const service = { dispose: () => void order.push("dispose"), idle: () => idle.then(() => void order.push("idle")) };
  const done = settleComposer(service, { seal: () => (order.push("seal"), seal.seal()) }, 60_000);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(order, ["dispose"], "nothing is sealed while a loop may still record its last row");
  assert.doesNotThrow(() => seal.guard());
  release();
  assert.equal(await done, true);
  assert.deepEqual(order, ["dispose", "idle", "seal"]);
  assert.throws(() => seal.guard(), (e: Error & { code?: string; detail?: Record<string, unknown> }) => e.code === "E_UNAVAILABLE" && e.detail?.["reason"] === "audit_sealed");
});

test("settleComposer: a loop that never settles is cut off at the bound, the writers are sealed anyway, and no timer is left", async () => {
  const timers = trackTimers();
  try {
    const seal = createAuditSeal();
    const stuck = { dispose: () => undefined, idle: () => new Promise<void>(() => undefined) };
    assert.equal(await settleComposer(stuck, seal, 5), false);
    assert.equal(seal.sealed(), true, "a late row is refused, never written after the final anchor");
    assert.equal(timers.live(), 0, "the bounding timer was cleared");
    const quick = createAuditSeal();
    assert.equal(await settleComposer({ dispose: () => undefined, idle: () => Promise.resolve() }, quick, 60_000), true);
    assert.equal(timers.live(), 0, "cleared when the loops settle first");
    assert.equal(await settleComposer(undefined, quick, 5), true, "no composer: nothing to wait for");
    assert.equal(quick.sealed(), true);
  } finally {
    timers.restore();
  }
});

test("S4: the composition hands its tool caps to the composer service (an invalid cap stops the host from starting)", async () => {
  const fix = hostFixture();
  const composed = composeDaemonHost(options(fix, { composer: { toolCaps: { callsPerReply: 0 } } }));
  try {
    const outcome = await composed.start().then((s) => s.degraded ?? "started", (e: unknown) => (e instanceof RangeError ? "refused" : `other:${String(e)}`));
    assert.equal(outcome, "refused");
  } finally {
    await composed.stop();
    fix.cleanup();
  }
});

test("C3 WT-2: the composer gets its own run snapshotter (a command's snapshots never replace a CLI run's held baseline)", async () => {
  const fix = hostFixture();
  const made: string[] = [];
  const counting: NonNullable<ComposeOptions["snapshotter"]> = (deps) => (made.push(deps.gitPath), snapshotter(deps));
  const composed = composeDaemonHost(options(fix, { snapshotter: counting }));
  try {
    await composed.start();
    assert.equal(made.length, 2, "one for CLI runs, one for composer commands, both with the host's one git");
    assert.equal(new Set(made).size, 1);
  } finally {
    await composed.stop();
    fix.cleanup();
  }
});
