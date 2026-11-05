// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// "Files changed outside the agent": the run-base diff decides, the watcher only adds evidence (design §10).
import { test } from "node:test";
import assert from "node:assert/strict";
import { ReviewSession, computeOutsideAgent } from "../src/index.js";
import { fixture, refusal, type Fixture } from "./fixture.js";

const BASE = Array.from({ length: 20 }, (_, i) => `l${i + 1}\n`).join("");

/** The worktree as a tree object, the way the daemon would record a run base or a run end. */
async function treeNow(f: Fixture): Promise<string> {
  return (await ReviewSession.start(f.deps, { worktree: f.wt, against: f.head() })).worktreeTree;
}

async function scenario(f: Fixture): Promise<{ runBase: string; runEnd: string }> {
  const runBase = f.head();
  f.write("a.txt", BASE.replace("l2\n", "AGENT\n"));
  f.write("agent-new.txt", "from the agent\n");
  return { runBase, runEnd: await treeNow(f) };
}

test("with a blind watcher, files edited after the run ended are still found from the trees", async () => {
  const f = fixture();
  try {
    const { runBase, runEnd } = await scenario(f);
    f.write("keep.txt", "user edit after the run\n");
    f.write("a.txt", BASE.replace("l2\n", "AGENT\n").replace("l3\n", "USER\n"));
    const r = await computeOutsideAgent(f.deps, { worktree: f.wt, runBase, runEnd, ledger: [], ledgerComplete: false });
    assert.equal(r.changedSinceRunBase, 3);
    assert.deepEqual(r.outsideAgent.map((x) => [x.path, x.evidence]), [["a.txt", "after-run"], ["keep.txt", "after-run"]]);
    assert.equal(r.outsideCount, 2);
    assert.equal(r.unattributedCount, 1, "the agent's new file is changed, not outside");
    assert.equal(r.attributionIncomplete, true);
    assert.equal(r.truncated, false);
  } finally {
    f.cleanup();
  }
});

test("a dropped watcher event never hides a change: it is in the changed set, unattributed", async () => {
  const f = fixture();
  try {
    const runBase = f.head();
    f.write("keep.txt", "edited during the run, event dropped\n");
    const r = await computeOutsideAgent(f.deps, { worktree: f.wt, runBase, ledger: [], ledgerComplete: false });
    assert.equal(r.changedSinceRunBase, 1);
    assert.equal(r.unattributedCount, 1);
    assert.equal(r.outsideCount, 0);
    assert.equal(r.attributionIncomplete, true, "and the report says it may be missing evidence");
  } finally {
    f.cleanup();
  }
});

test("during a run the ledger supplies the evidence, and only for paths the diff shows changed", async () => {
  const f = fixture();
  try {
    const runBase = f.head();
    f.write("keep.txt", "user edit during the run\n");
    f.write("a.txt", BASE.replace("l2\n", "AGENT\n"));
    // `reverted.txt` was written by the user and put back: nothing to review. The rest are not usable paths.
    const ledger = ["keep.txt", "reverted.txt", "../escape", "/etc/passwd", ".git/hooks/x", "", 42 as unknown as string];
    const r = await computeOutsideAgent(f.deps, { worktree: f.wt, runBase, ledger, ledgerComplete: true });
    assert.deepEqual(r.outsideAgent.map((x) => [x.path, x.evidence]), [["keep.txt", "ledger"]]);
    assert.equal(r.unattributedCount, 1);
    assert.equal(r.attributionIncomplete, false);
  } finally {
    f.cleanup();
  }
});

test("a path with both kinds of evidence says so, and names are escaped for display", async () => {
  const f = fixture();
  try {
    const runBase = f.head();
    f.write("we\nird.txt", "1\n");
    const runEnd = await treeNow(f);
    f.write("we\nird.txt", "2\n");
    const r = await computeOutsideAgent(f.deps, { worktree: f.wt, runBase, runEnd, ledger: ["we\nird.txt"], ledgerComplete: true });
    assert.deepEqual(r.outsideAgent.map((x) => [x.displayPath, x.evidence]), [["we\\nird.txt", "both"]]);
  } finally {
    f.cleanup();
  }
});

test("a path the user reverted to the run base after the run is not a change to show", async () => {
  const f = fixture();
  try {
    const { runBase, runEnd } = await scenario(f);
    f.write("a.txt", BASE);
    const r = await computeOutsideAgent(f.deps, { worktree: f.wt, runBase, runEnd, ledger: [], ledgerComplete: true });
    assert.deepEqual(r.outsideAgent, []);
    assert.equal(r.changedSinceRunBase, 1);
  } finally {
    f.cleanup();
  }
});

test("the ledger and the lists are bounded and say so when they are cut", async () => {
  const f = fixture({ deps: { limits: { maxLedger: 2, maxFiles: 2 } } });
  try {
    const runBase = f.head();
    for (const n of ["a1", "a2", "a3"]) f.write(`${n}.txt`, "x\n");
    const r = await computeOutsideAgent(f.deps, { worktree: f.wt, runBase, ledger: ["a1.txt", "a2.txt", "a3.txt", "a4.txt"], ledgerComplete: true });
    assert.equal(r.truncated, true);
    assert.ok(r.outsideAgent.length <= 2);
    assert.ok(r.outsideCount >= r.outsideAgent.length);
  } finally {
    f.cleanup();
  }
});

test("a worktree tree already taken can be passed in, and bad object ids are refused", async () => {
  const f = fixture();
  try {
    const runBase = f.head();
    f.write("keep.txt", "x\n");
    const current = await treeNow(f);
    const before = f.indexes.created;
    const r = await computeOutsideAgent(f.deps, { worktree: f.wt, runBase, current, ledger: ["keep.txt"], ledgerComplete: true });
    assert.equal(r.outsideCount, 1);
    assert.equal(f.indexes.created, before, "the worktree was not read again");
    for (const bad of [{ runBase: "HEAD" }, { runBase: "x".repeat(40) }, { runEnd: "not-an-oid" }, { current: "--output=x" }]) {
      const e = await refusal(computeOutsideAgent(f.deps, { worktree: f.wt, runBase, ledger: [], ledgerComplete: true, ...bad }));
      assert.equal(e.code, "E_INVALID_ARGUMENT");
    }
  } finally {
    f.cleanup();
  }
});
