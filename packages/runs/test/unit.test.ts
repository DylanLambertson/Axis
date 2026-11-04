// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { RUN_STATES } from "@axis/journal";
import { RUN_AUDIT_ACTIONS, RUN_AUDIT_ALLOWLIST } from "../src/audit.js";
import { RUN_COPY, copyStrings } from "../src/copy.js";
import { buildLaunchDialog } from "../src/dialog.js";
import { resolveLimits } from "../src/limits.js";
import { RingBuffer } from "../src/ring.js";
import { RUN_REASONS, deriveStatus, deriveWorkspaceStatus, type RunStatus } from "../src/status.js";
import { CLI } from "./helpers.js";

test("copy: nothing says sandbox or secure, and the disclosure statements are all present", () => {
  const strings = [...copyStrings()];
  assert.ok(strings.length > 15);
  for (const s of strings) assert.ok(!/sandbox|secur/i.test(s), `forbidden word in: ${s}`);
  assert.ok(RUN_COPY.launchDialog.governedBy.includes("governed by the CLI's own permissions"));
  assert.ok(RUN_COPY.launchDialog.canPush.includes("can push"));
  assert.ok(RUN_COPY.runRow.governedBy.toLowerCase().includes("governed by the cli's own permissions"));
  assert.equal(RUN_COPY.status.quiet, "quiet (may be waiting for input)");
  assert.equal(RUN_COPY.refusals.commitWhileRunning, "Stop the agent run to commit");
  assert.ok(Object.isFrozen(RUN_COPY) && Object.isFrozen(RUN_COPY.launchDialog));
  assert.throws(() => {
    (RUN_COPY.launchDialog as { title: string }).title = "changed";
  });
});

test("launch dialog: states the CLI's own permissions and that it can push; shows counts, not arguments; strips unsafe text", () => {
  const d = buildLaunchDialog({ agent: { ...CLI, label: "My\u202e CLI\u200b", args: ["--flag-key-one", "x"] }, worktree: "/work/ws-1" });
  assert.deepEqual(d.statements.slice(0, 2), [RUN_COPY.launchDialog.governedBy, RUN_COPY.launchDialog.canPush]);
  assert.equal(d.statements.length, 5);
  assert.equal(d.agentLabel, "My CLI");
  assert.equal(d.executable, "fakecli");
  assert.equal(d.argCount, 2);
  assert.ok(!JSON.stringify(d).includes("--flag-key-one"));
  assert.ok(Object.isFrozen(d) && Object.isFrozen(d.statements));
  for (const s of [d.title, d.confirmLabel, d.cancelLabel, ...d.statements]) assert.ok(!/sandbox|secur/i.test(s));
  assert.throws(() => buildLaunchDialog({ agent: { nope: 1 }, worktree: "/w" }), TypeError);
  const long = buildLaunchDialog({ agent: CLI, worktree: "/w/" + "a".repeat(1000) });
  assert.ok(long.worktree.length <= 203);
});

test("status derivation covers every journal state and reason", () => {
  const live = (phase: "starting" | "running" | "stopping", at: number) => ({ phase, lastActivityAt: at });
  const base = { now: 100_000, quietMs: 60_000 };
  const s = (state: (typeof RUN_STATES)[number], reason: string | null, l?: ReturnType<typeof live>): RunStatus =>
    deriveStatus({ state, reason, live: l, ...base });
  assert.equal(s("QUEUED", null, live("starting", 0)), "starting");
  assert.equal(s("QUEUED", null), "interrupted");
  assert.equal(s("RUNNING", null, live("running", 90_000)), "running");
  assert.equal(s("RUNNING", null, live("running", 40_000)), "quiet");
  assert.equal(s("RUNNING", null, live("running", 40_001)), "running");
  assert.equal(s("RUNNING", null, live("stopping", 90_000)), "stopping");
  assert.equal(s("CANCELLED", RUN_REASONS.killUnconfirmed, live("stopping", 0)), "stopping", "the row ended but a process may live");
  assert.equal(s("CANCELLED", RUN_REASONS.spawnTimeout, live("starting", 0)), "stopping");
  assert.equal(s("RUNNING", null, live("starting", 0)), "starting");
  assert.equal(s("RUNNING", null), "interrupted", "a row that says RUNNING with no process here is not running");
  assert.equal(s("REVIEWING", RUN_REASONS.exited), "finished");
  assert.equal(s("COMPLETED", null), "finished");
  assert.equal(s("FAILED", RUN_REASONS.nonZero), "failed");
  assert.equal(s("BLOCKED", "INTERRUPTED_BY_RESTART"), "interrupted");
  assert.equal(s("BLOCKED", null), "interrupted");
  assert.equal(s("CANCELLED", RUN_REASONS.userKilled), "killed");
  assert.equal(s("CANCELLED", RUN_REASONS.killUnconfirmed), "killed");
  assert.equal(s("CANCELLED", RUN_REASONS.userDiscarded), "killed");
  assert.equal(s("CANCELLED", "INTERRUPTED_BY_RESTART"), "interrupted");
  for (const r of ["spawnFailed", "spawnTimeout", "snapshotFailed", "auditFailed", "launchRefused", "journalFailed"] as const) {
    assert.equal(s("CANCELLED", RUN_REASONS[r]), "failed", r);
  }
  for (const state of RUN_STATES) assert.ok(s(state, null).length > 0);
});

test("workspace status: a live run wins, quiet only when all live runs are quiet, else the latest run", () => {
  const r = (status: RunStatus, createdAt: string) => ({ status, createdAt });
  assert.equal(deriveWorkspaceStatus([]), "idle");
  assert.equal(deriveWorkspaceStatus([r("quiet", "1"), r("running", "2")]), "running");
  assert.equal(deriveWorkspaceStatus([r("quiet", "1"), r("quiet", "2")]), "quiet");
  assert.equal(deriveWorkspaceStatus([r("starting", "1")]), "running");
  assert.equal(deriveWorkspaceStatus([r("failed", "1"), r("finished", "2")]), "done");
  assert.equal(deriveWorkspaceStatus([r("finished", "1"), r("failed", "2")]), "failed");
  assert.equal(deriveWorkspaceStatus([r("finished", "1"), r("killed", "2")]), "idle");
  assert.equal(deriveWorkspaceStatus([r("interrupted", "1")]), "failed");
});

test("ring buffer: bounded, ordered, counts what it dropped", () => {
  const b = new RingBuffer(10);
  b.append("abcdef");
  b.append("ghijkl");
  assert.equal(b.tail(100), "cdefghijkl");
  assert.equal(b.length, 10);
  assert.equal(b.droppedChars, 2);
  b.append("0123456789ABCDEF");
  assert.equal(b.tail(100), "6789ABCDEF");
  assert.equal(b.tail(3), "DEF");
  assert.equal(b.totalChars, 6 + 6 + 16);
  assert.equal(b.totalChars - b.droppedChars, 10);
  b.append("");
  assert.equal(b.tail(0), "");
  assert.throws(() => new RingBuffer(0), RangeError);
  assert.throws(() => new RingBuffer(2 ** 30), RangeError);
});

test("ring buffer: many tiny chunks keep the chunk list short", () => {
  const b = new RingBuffer(2048);
  for (let i = 0; i < 100_000; i++) b.append("z");
  assert.equal(b.length, 2048);
  assert.equal(b.tail(5000), "z".repeat(2048));
});

test("limits are validated and defaulted", () => {
  assert.equal(resolveLimits(undefined).maxConcurrent, 4);
  assert.equal(resolveLimits({ maxConcurrent: 2 }).maxConcurrent, 2);
  for (const bad of [{ maxConcurrent: 0 }, { maxConcurrent: 33 }, { quietMs: -1 }, { outputBufferChars: 10 }, { graceMs: 1.5 }, { cols: 1 }, { nope: 1 }]) {
    assert.throws(() => resolveLimits(bad as never), /Invalid run limits/);
  }
  assert.throws(() => resolveLimits(null as never));
});

test("the audit allowlist lists keys for exactly the actions this package writes", () => {
  assert.deepEqual(Object.keys(RUN_AUDIT_ALLOWLIST).sort(), Object.values(RUN_AUDIT_ACTIONS).sort());
  for (const keys of Object.values(RUN_AUDIT_ALLOWLIST)) for (const k of keys) assert.ok(!/env|arg|output|text|message/i.test(k) || k === "argCount" || k === "removedEnvCount", k);
});
