// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createDaemonHost, createReviewAuditSink, createReviewDiffHandler, AckSessions, ReviewedTrees, REVIEW_PAYLOAD_ALLOWLIST, type ReviewRound } from "../src/index.js";
import { hostFixture } from "../testing/host-fixture.js";
import { files, gitUnavailable, LONG_LINE, reviewRig, sha256, uuid, type Client, type ReviewRig, type RigOptions } from "./review-rig.js";
import { must } from "./helpers.js";

const SKIP = gitUnavailable();
async function setup(t: TestContext, options: RigOptions = {}): Promise<{ r: ReviewRig; user: Client }> {
  const r = await reviewRig(options);
  t.after(() => r.cleanup());
  return { r, user: await r.connect() };
}
/** Checks out `branch` (created at HEAD) without `-b`. */
const checkout = (r: ReviewRig, branch: string): void => {
  r.git("update-ref", `refs/heads/${branch}`, r.git("rev-parse", "HEAD").trim());
  r.git("symbolic-ref", "HEAD", `refs/heads/${branch}`);
};
const nothingRecorded = (r: ReviewRig): void => {
  assert.equal(r.calls.recordReviewedTree, 0);
  assert.equal(r.trees.size, 0);
  assert.equal(r.acks.length, 0);
  assert.equal(r.journal.getWorkspace(r.workspaceId)?.reviewedTreeHash, null);
};

test("a branch that is not axis/<slug> is treated like a detached HEAD: files listed, no tree, nothing audited or recorded", { skip: SKIP ?? false }, async (t) => {
  const { r, user } = await setup(t);
  checkout(r, "main");
  r.write("a.txt", "a\n");
  r.write("long.txt", LONG_LINE);
  const first = await user.call("diff", { workspaceId: r.workspaceId });
  assert.equal(first.ok, true, JSON.stringify(first.error));
  assert.equal(first.result?.["branch"], null);
  assert.equal(first.result?.["treeHash"], null);
  assert.equal(files(first).length, 2);
  const long = files(first).find((f) => f["truncated"]);
  const second = await user.call("diff", { workspaceId: r.workspaceId, acknowledged: [{ fileId: long?.["fileId"], contentId: long?.["contentId"] }] });
  assert.equal(second.ok, true);
  assert.equal(second.result?.["treeHash"], null);
  nothingRecorded(r);
});

test("a tree is withheld when the checked-out branch is not the workspace's branch in the journal", { skip: SKIP ?? false }, async (t) => {
  const { r, user } = await setup(t);
  checkout(r, "axis/other");
  r.write("long.txt", LONG_LINE);
  const first = await user.call("diff", { workspaceId: r.workspaceId });
  const row = files(first)[0];
  const res = await user.call("diff", { workspaceId: r.workspaceId, acknowledged: [{ fileId: row?.["fileId"], contentId: row?.["contentId"] }] });
  assert.equal(res.ok, true, JSON.stringify(res.error));
  assert.equal(res.result?.["branch"], "axis/other");
  assert.equal(res.result?.["treeHash"], null);
  nothingRecorded(r);
  // Back on the workspace's own branch the same review gets its tree.
  checkout(r, "axis/feat");
  const ok = await user.call("diff", { workspaceId: r.workspaceId, acknowledged: [{ fileId: row?.["fileId"], contentId: row?.["contentId"] }] });
  assert.notEqual(ok.result?.["treeHash"], null);
});

test("a request cancelled while the tree is built records nothing", { skip: SKIP ?? false }, async (t) => {
  const ac = new AbortController();
  const recorded: string[] = [];
  const round: ReviewRound = {
    head: "a".repeat(40), branch: "axis/feat", skippedCount: 0, skipped: [],
    files: [{ path: "a.txt", status: "A", kind: "text", newMode: "100644", newOid: "b".repeat(40), unsafePath: false, protectedRules: [], warnings: [] }],
    hasCutLines: async () => false,
    accept: () => undefined,
    build: async () => (ac.abort(), { reviewedTree: "c".repeat(40), head: "a".repeat(40), branch: "axis/feat", handle: {} as never }),
  };
  const trees = new ReviewedTrees();
  const handler = createReviewDiffHandler({
    review: { open: async () => round },
    journal: { recordReviewedTree: (() => void recorded.push("journal")) as never, getRun: () => undefined, transitionRun: (() => undefined) as never, getWorkspace: (() => ({ branch: "axis/feat" })) as never },
    runs: { get: () => { throw new Error("unused"); } },
    audit: { append: () => undefined },
    trees,
  });
  const identity = { connectionId: "c".repeat(22), windowId: "w", actorId: "u", actor: "user", trusted: true, clientKind: "desktop" } as const;
  await assert.rejects(async () => handler({ identity, requestId: "r", correlationId: "c", signal: ac.signal } as never, { workspaceId: uuid() } as never), (e: { code?: string }) => e.code === "E_CANCELLED");
  assert.deepEqual(recorded, []);
  assert.equal(trees.size, 0);
});

test("the acknowledgement row reaches the host's real audit log with its file id and nothing else", async () => {
  const fix = hostFixture();
  const host = createDaemonHost(fix.config, fix.ports);
  try {
    const s = await host.start();
    const audit = must(s.audit);
    const fileId = await sha256("some/path.txt");
    createReviewAuditSink(audit).append({ action: "review.acknowledge", actor: "user", workspaceId: "ws-1", connectionId: "c".repeat(22), fileId });
    audit.append({ actor: "user", action: "review.acknowledge", target: "workspace:ws-2", outcome: "success", payload: { fileId, path: "some/path.txt", contentId: "x" } });
    const rows = s.auditRead.list({ limit: 50 }).filter((e) => e.action === "review.acknowledge");
    assert.equal(rows.length, 2);
    const payloads = rows.map((e) => e.payload as Record<string, unknown>);
    for (const p of payloads) assert.equal(p["fileId"], fileId);
    for (const p of payloads) assert.deepEqual(Object.keys(p).filter((k) => k !== "_omitted" && k !== "fileId"), [], "a key outside the allow-list is dropped");
    assert.equal(payloads.filter((p) => p["_omitted"] === 2).length, 1, "the foreign keys of the direct append were counted and dropped");
    assert.equal(payloads.filter((p) => p["_omitted"] === undefined).length, 1, "the sink's own row carries the file id only");
    assert.equal(rows.some((e) => e.target === "workspace:ws-1"), true);
    assert.deepEqual(REVIEW_PAYLOAD_ALLOWLIST["review.acknowledge"], ["fileId"]);
  } finally {
    await host.stop();
    fix.cleanup();
  }
});

test("the audit sink refuses a writer that answers with a promise", () => {
  const sink = createReviewAuditSink({ append: () => Promise.resolve() });
  assert.throws(() => sink.append({ action: "review.acknowledge", actor: "user", workspaceId: "w", connectionId: "c", fileId: "f" }));
});

test("complete: a failed read-back is E_UNAVAILABLE after the run was completed, and a retry finds it completed", { skip: SKIP ?? false }, async (t) => {
  const { r, user } = await setup(t, { runsFail: true });
  const run = r.newRun();
  const res = await user.call("complete", { runId: run }, uuid());
  assert.equal(res.error?.code, "E_UNAVAILABLE");
  assert.equal(r.journal.getRun(run)?.state, "COMPLETED");
  const retry = await user.call("complete", { runId: run }, uuid());
  assert.equal(retry.error?.code, "E_CONFLICT");
  assert.equal(retry.error?.details?.["reason"], "not_reviewing");
});

test("complete asks the journal to move the run only from REVIEWING", { skip: SKIP ?? false }, async (t) => {
  const { r, user } = await setup(t);
  await user.call("complete", { runId: r.newRun() }, uuid());
  assert.equal((r.transitionOptions[0] as { expectedFrom?: string }).expectedFrom, "REVIEWING");
});

test("workspaces beyond the bound are forgotten, and a forgotten tree is refused as stale", () => {
  const trees = new ReviewedTrees({ maxWorkspaces: 2, maxPerWorkspace: 2 });
  const h = {} as never;
  for (const id of ["w1", "w2", "w3"]) trees.record({ workspaceId: id, treeHash: "a".repeat(40), parent: "b".repeat(40), branch: "axis/x", handle: h });
  assert.equal(trees.size, 2);
  assert.throws(() => trees.lookupReviewedTree("w1", "a".repeat(40)), (e: { details?: { reason?: string } }) => e.details?.reason === "stale");
  assert.equal(trees.lookupReviewedTree("w3", "a".repeat(40)).workspaceId, "w3");
  // Recording again moves a workspace to the newest position.
  trees.record({ workspaceId: "w2", treeHash: "d".repeat(40), parent: "b".repeat(40), branch: "axis/x", handle: h });
  trees.record({ workspaceId: "w4", treeHash: "a".repeat(40), parent: "b".repeat(40), branch: "axis/x", handle: h });
  assert.equal(trees.lookupReviewedTree("w2", "d".repeat(40)).workspaceId, "w2");
  assert.throws(() => trees.lookupReviewedTree("w3", "a".repeat(40)));
});

test("an acknowledgement session is bounded: past the bound it can only be audited again, never skipped", () => {
  const acks = new AckSessions({ maxSessions: 2, maxPairsPerSession: 2 });
  acks.commit("s", "f1", "c");
  acks.commit("s", "f2", "c");
  assert.equal(acks.isFirst("s", "f1", "c"), false);
  acks.commit("s", "f3", "c");
  assert.equal(acks.isFirst("s", "f3", "c"), false);
  assert.equal(acks.isFirst("s", "f1", "c"), true, "dropped when the bound was hit");
  acks.commit("s2", "f1", "c");
  acks.commit("s3", "f1", "c");
  assert.equal(acks.isFirst("s", "f3", "c"), true, "the oldest session was dropped");
  assert.equal(acks.isFirst("s3", "f1", "c"), false);
});

test("a reply the contract would refuse is refused before anything is audited or recorded", { skip: SKIP ?? false }, async (t) => {
  const bad = { path: "a.txt", status: "A", kind: "text", newMode: "100644", newOid: "b".repeat(40), similarity: 500, unsafePath: false, protectedRules: [], warnings: [] } as const;
  const { r, user } = await setup(t, {
    review: () => ({
      open: async () => ({
        head: "a".repeat(40), branch: "axis/feat", skippedCount: 0, skipped: [], files: [bad], hasCutLines: async () => false, accept: () => undefined,
        build: async () => ({ reviewedTree: "c".repeat(40), head: "a".repeat(40), branch: "axis/feat", handle: {} as never }),
      }),
    }),
  });
  const res = await user.call("diff", { workspaceId: r.workspaceId });
  assert.equal(res.error?.code, "E_INTERNAL");
  nothingRecorded(r);
});
