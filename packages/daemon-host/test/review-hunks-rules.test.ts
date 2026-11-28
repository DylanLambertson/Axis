// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// DC-2 handler rules driven one at a time with a fake round: what reaches the port, what is echoed, what is escaped, and
// that nothing is registered for a refused, cancelled or unrepresentable build.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createReviewBuildHandler, createReviewHunksHandler, wireText } from "../src/handlers/review-hunks.js";
import { fileIdOf, versionIdOf } from "../src/handlers/review-wire.js";
import { ReviewedTrees } from "../src/index.js";
import type { ReviewRound, RoundFile, RoundHunk } from "../src/ports/review.js";

const HEAD = "a".repeat(40);
const file = (path: string, over: Partial<RoundFile> = {}): RoundFile => ({
  path, status: "M", kind: "text", oldMode: "100644", oldOid: "1".repeat(40), newMode: "100644", newOid: "2".repeat(40), unsafePath: false, protectedRules: [], warnings: [], ...over,
});
const line = (kind: " " | "-" | "+", text: string, truncated = false) => ({ kind, text, eol: "lf" as const, truncated });
const hunk = (i: number, truncated = false): RoundHunk => ({ id: `${i}:${"0123456789abcdef"}`, header: "@@ -1,1 +1,1 @@", lines: [line("-", "old"), line("+", "new", truncated)], truncated });

interface Seen {
  accepted: Array<[string, string | null, boolean]>;
  built: number;
  recorded: string[];
  audited: string[];
}
function rig(files: RoundFile[], over: { hunks?: (p: string) => RoundHunk[] | string; cut?: (p: string) => boolean; tree?: string; onBuild?: () => void; failAudit?: boolean; branch?: string | null } = {}) {
  const seen: Seen = { accepted: [], built: 0, recorded: [], audited: [] };
  const round: ReviewRound = {
    head: HEAD, branch: over.branch === undefined ? "axis/feat" : over.branch, files, skipped: [], skippedCount: 0,
    hasCutLines: async (p) => over.cut?.(p) ?? false,
    readNewBlob: async () => { throw new Error("not read"); },
    accept: (p, o) => void seen.accepted.push([p, null, o.acceptTruncated]),
    hunks: async (p) => {
      const h = over.hunks?.(p) ?? [hunk(0), hunk(1)];
      return typeof h === "string" ? { kind: "file-level", reason: h } : { kind: "hunks", hunks: h };
    },
    acceptHunk: (p, id, o) => void seen.accepted.push([p, id, o.acceptTruncated]),
    build: async () => (seen.built++, over.onBuild?.(), { reviewedTree: over.tree ?? "c".repeat(40), head: HEAD, branch: "axis/feat", handle: {} as never }),
  };
  const trees = new ReviewedTrees();
  const deps = {
    review: { open: async () => round },
    journal: { recordReviewedTree: (() => { throw new Error("only through recordAsUser"); }) as never, getRun: () => undefined, transitionRun: (() => undefined) as never, getWorkspace: (() => ({ branch: "axis/feat" })) as never },
    runs: { get: () => { throw new Error("unused"); } },
    audit: { append: (e: { fileId: string }) => { if (over.failAudit) throw new Error("down"); seen.audited.push(e.fileId); } },
    trees,
  };
  return { seen, trees, hunksH: createReviewHunksHandler(deps), buildH: createReviewBuildHandler(deps, (ws, tree) => void seen.recorded.push(`${ws}:${tree}`)) };
}
const identity = { connectionId: "c".repeat(22), windowId: "w", actorId: "u", actor: "user", trusted: true, clientKind: "desktop" } as const;
const ctx = (signal = new AbortController().signal) => ({ identity, requestId: "r", correlationId: "c", signal }) as never;
const code = async (p: unknown): Promise<[string | undefined, unknown]> => {
  try {
    await p;
    return [undefined, undefined];
  } catch (e) {
    const x = e as { code?: string; details?: { reason?: unknown } };
    return [x.code, x.details?.reason];
  }
};
const ids = (f: RoundFile) => ({ fileId: fileIdOf(f.path), versionId: versionIdOf(f, f.protectedRules.length > 0) });
const req = (selection: unknown[]) => ({ workspaceId: "ws-1", head: HEAD, selection }) as never;

test("acceptTruncated reaches the port only for an acknowledged hunk or file that this round cuts", async () => {
  const a = file("a.txt");
  const w = file("w.txt");
  const { seen, buildH } = rig([a, w], { hunks: () => [hunk(0), hunk(1, true), hunk(2)], cut: () => false });
  const res = await buildH(ctx(), req([
    { ...ids(a), hunkIds: [hunk(0).id, hunk(1).id], acknowledgedHunkIds: [hunk(0).id, hunk(1).id] },
    { ...ids(w), whole: true, acknowledged: true },
  ]));
  assert.deepEqual(seen.accepted, [["a.txt", hunk(0).id, false], ["a.txt", hunk(1).id, true], ["w.txt", null, false]]);
  assert.deepEqual((res as { selection: unknown[] }).selection, [
    { ...ids(a), hunkIds: [hunk(0).id, hunk(1).id], acknowledgedHunkIds: [hunk(1).id] },
    { ...ids(w), whole: true },
  ], "a partial selection is never reported whole, and only applied acknowledgements are echoed");
  assert.deepEqual(seen.audited, [fileIdOf("a.txt")]);
});

test("a cut hunk or file without its acknowledgement is refused by the handler, before the port is asked to accept anything", async () => {
  const a = file("a.txt");
  // This fake port accepts everything: the refusal must be the handler's own, not the core's second check.
  const { seen, buildH } = rig([a], { hunks: () => [hunk(0), hunk(1, true)], cut: () => true });
  assert.deepEqual(await code(buildH(ctx(), req([{ ...ids(a), hunkIds: [hunk(0).id, hunk(1).id], acknowledgedHunkIds: [hunk(0).id] }]))), ["E_CONFLICT", "truncated_hunk"]);
  assert.deepEqual(await code(buildH(ctx(), req([{ ...ids(a), whole: true }]))), ["E_CONFLICT", "truncated_hunk"]);
  assert.deepEqual(seen.accepted, []);
  assert.equal(seen.built, 0);
  assert.deepEqual(seen.audited, []);
});

test("a branch other than the workspace's own is refused before anything is accepted, audited or built", async () => {
  const a = file("a.txt");
  for (const branch of ["axis/other", null, "main"]) {
    const { seen, buildH } = rig([a], { branch, cut: () => true });
    assert.deepEqual(await code(buildH(ctx(), req([{ ...ids(a), whole: true, acknowledged: true }]))), ["E_CONFLICT", "not_head"], String(branch));
    assert.deepEqual([seen.accepted, seen.audited, seen.built], [[], [], 0], String(branch));
  }
});

test("unusable and filtered files are refused before anything is accepted", async () => {
  for (const [f, reason] of [[file("u.txt", { unsafePath: true }), "unsafe_path"], [file("f.txt", { kind: "filtered" }), "filtered_path"], [file("bad\ufffd.txt"), "unsafe_path"]] as const) {
    const { seen, buildH, hunksH } = rig([f]);
    assert.deepEqual(await code(buildH(ctx(), req([{ ...ids(f), whole: true }]))), ["E_CONFLICT", reason]);
    assert.deepEqual(seen.accepted, []);
    assert.equal(seen.built, 0);
    const h = (await hunksH(ctx(), { workspaceId: "ws-1", fileId: fileIdOf(f.path) } as never)) as Record<string, unknown>;
    assert.equal(h["fileLevelReason"], reason);
  }
});

test("a core reason outside the closed set is shown as unreadable", async () => {
  const a = file("a.txt");
  const { hunksH } = rig([a], { hunks: () => "a reason nobody listed" });
  assert.equal(((await hunksH(ctx(), { workspaceId: "ws-1", fileId: fileIdOf("a.txt") } as never)) as Record<string, unknown>)["fileLevelReason"], "unreadable");
});

test("a tree the reply cannot carry is not registered; a cancellation during the build registers nothing; a failed audit builds nothing", async () => {
  const a = file("a.txt");
  const bad = rig([a], { tree: "not-a-tree" });
  assert.deepEqual(await code(bad.buildH(ctx(), req([{ ...ids(a), whole: true }]))), ["E_INTERNAL", undefined]);
  assert.deepEqual(bad.seen.recorded, []);
  assert.equal(bad.trees.size, 0);
  const ac = new AbortController();
  const cancelled = rig([a], { onBuild: () => ac.abort() });
  assert.deepEqual(await code(cancelled.buildH(ctx(ac.signal), req([{ ...ids(a), whole: true }]))), ["E_CANCELLED", undefined]);
  assert.deepEqual(cancelled.seen.recorded, []);
  assert.equal(cancelled.trees.size, 0);
  const noAudit = rig([a], { cut: () => true, failAudit: true });
  assert.deepEqual(await code(noAudit.buildH(ctx(), req([{ ...ids(a), whole: true, acknowledged: true }]))), ["E_INTERNAL", undefined]);
  assert.equal(noAudit.seen.built, 0);
  assert.deepEqual(noAudit.seen.recorded, []);
});

test("the version id binds both sides, the old path and the protected flag", () => {
  const base = file("a.txt");
  const v = versionIdOf(base, false);
  for (const over of [{ oldMode: "100755" }, { oldOid: "3".repeat(40) }, { newMode: "100755" }, { newOid: "3".repeat(40) }, { oldPath: "z.txt" }]) {
    assert.notEqual(versionIdOf({ ...base, ...over }, false), v, JSON.stringify(over));
  }
  assert.notEqual(versionIdOf(base, true), v, "the protected flag");
  assert.equal(versionIdOf(file("a.txt"), false), v, "the same facts give the same id");
});

test("text the core leaves unescaped is escaped for the wire, and only that", () => {
  assert.equal(wireText("a\u0600b"), "a\\u{600}b");
  assert.equal(wireText("\u0301x"), "\\u{301}x", "a combining mark that would lead the line");
  assert.equal(wireText("x\u0301"), "x\u0301", "a combining mark after a base is kept");
  assert.equal(wireText("\tplain \\\\ \\u{202e}"), "\tplain \\\\ \\u{202e}", "tab and the core's escapes unchanged");
  assert.equal(wireText("\u{1d173}"), "\\u{1d173}");
});
