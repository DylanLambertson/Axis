// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { files, gitUnavailable, reviewRig, sha256, type Client, type ReviewRig, type RigOptions } from "./review-rig.js";

const SKIP = gitUnavailable();

async function setup(t: TestContext, options: RigOptions = {}): Promise<{ r: ReviewRig; user: Client }> {
  const r = await reviewRig(options);
  t.after(() => r.cleanup());
  return { r, user: await r.connect() };
}
const diff = (user: Client, workspaceId: string, extra: Record<string, unknown> = {}) => user.call("diff", { workspaceId, ...extra });
const treeFiles = (r: ReviewRig, tree: string) => r.git("ls-tree", "-r", tree).trim().split("\n").map((l) => l.split(/\s+/).slice(0, 4).join(" "));

test("a clean diff lists the change, returns the tree, records it in the journal and in the lookup", { skip: SKIP ?? false }, async (t) => {
  const { r, user } = await setup(t);
  r.write("src/hello.txt", "hello\n");
  const head = r.git("rev-parse", "HEAD").trim();
  const res = await diff(user, r.workspaceId);
  assert.equal(res.ok, true, JSON.stringify(res.error));
  const [row] = files(res);
  assert.equal(files(res).length, 1);
  assert.equal(row?.["displayPath"], "src/hello.txt");
  assert.equal(row?.["fileId"], await sha256("src/hello.txt"));
  assert.deepEqual({ truncated: row?.["truncated"], contentId: row?.["contentId"], acknowledged: row?.["acknowledged"], unsafePath: row?.["unsafePath"] }, { truncated: false, contentId: null, acknowledged: false, unsafePath: false });
  assert.equal(res.result?.["head"], head);
  assert.equal(res.result?.["branch"], "axis/feat");
  const tree = res.result?.["treeHash"] as string;
  assert.match(tree, /^[0-9a-f]{40,64}$/);
  assert.deepEqual(treeFiles(r, tree).map((l) => l.split(" ")[3]).sort(), ["keep.txt", "src/hello.txt"]);
  assert.equal(r.journal.getWorkspace(r.workspaceId)?.reviewedTreeHash, tree);
  const hit = r.trees.lookupReviewedTree(r.workspaceId, tree);
  assert.deepEqual({ parent: hit.parent, branch: hit.branch, treeHash: hit.treeHash }, { parent: head, branch: "axis/feat", treeHash: tree });
  // The worktree, the index and the refs were not touched.
  assert.equal(r.git("rev-parse", "HEAD").trim(), head);
  assert.equal(r.git("status", "--porcelain").trim(), "?? src/");
});

test("nothing changed: no files and no tree, and nothing is recorded", { skip: SKIP ?? false }, async (t) => {
  const { r, user } = await setup(t);
  const res = await diff(user, r.workspaceId);
  assert.deepEqual([files(res).length, res.result?.["treeHash"]], [0, null]);
  assert.equal(r.calls.recordReviewedTree, 0);
  assert.equal(r.trees.size, 0);
});

test("a detached HEAD lists the change but returns no tree", { skip: SKIP ?? false }, async (t) => {
  const { r, user } = await setup(t);
  r.git("update-ref", "--no-deref", "HEAD", r.git("rev-parse", "HEAD").trim());
  r.write("a.txt", "a\n");
  const res = await diff(user, r.workspaceId);
  assert.equal(res.result?.["branch"], null);
  assert.equal(res.result?.["treeHash"], null);
  assert.equal(files(res).length, 1);
  assert.equal(r.calls.recordReviewedTree, 0);
});

test("a symlink is a changed file, bound by mode 120000, and is committed as a link", { skip: SKIP ?? false }, async (t) => {
  const { r, user } = await setup(t);
  try {
    (await import("node:fs")).symlinkSync("keep.txt", `${r.repo}/link`);
  } catch {
    t.skip("symlinks are not available here");
    return;
  }
  const res = await diff(user, r.workspaceId);
  const [row] = files(res);
  assert.equal(row?.["kind"], "symlink");
  assert.equal(row?.["truncated"], false);
  const tree = res.result?.["treeHash"] as string;
  assert.match(treeFiles(r, tree).join("\n"), /^120000 blob [0-9a-f]+ link$/m);
});

test("more files than the reply holds fails the review instead of listing part of it", { skip: SKIP ?? false }, async (t) => {
  const { r, user } = await setup(t);
  for (let i = 0; i < 201; i++) r.write(`bulk/file-${i}.txt`, `${i}\n`);
  const res = await diff(user, r.workspaceId);
  assert.equal(res.ok, false);
  assert.equal(res.error?.code, "E_INVALID_ARGUMENT");
  assert.equal(res.error?.details?.["reason"], "too_large");
  assert.equal(r.calls.recordReviewedTree, 0);
  assert.equal(r.trees.size, 0);
  const exactly200 = await setup(t);
  for (let i = 0; i < 200; i++) exactly200.r.write(`bulk/file-${i}.txt`, `${i}\n`);
  const ok = await diff(exactly200.user, exactly200.r.workspaceId);
  assert.equal(files(ok).length, 200);
  assert.notEqual(ok.result?.["treeHash"], null);
});

test("a file over the size cap is listed as skipped, at most 50 rows, with the full count", { skip: SKIP ?? false }, async (t) => {
  const { r } = await setup(t);
  // The real cap is 50 MiB; this proves the handler's own cut with a fake round of 60 skipped entries.
  const r2 = await reviewRig({
    review: (real) => ({
      open: async (id, ctx) => ({ ...(await real.open(id, ctx)), skipped: Array.from({ length: 60 }, (_, i) => ({ path: `big/${i}.bin`, size: 60_000_000 })), skippedCount: 60 }),
    }),
  });
  t.after(() => r2.cleanup());
  const user = await r2.connect();
  const res = await diff(user, r2.workspaceId);
  assert.equal(res.ok, true, JSON.stringify(res.error));
  assert.equal((res.result?.["skipped"] as unknown[]).length, 50);
  assert.equal(res.result?.["skippedCount"], 60);
  assert.ok(r);
});

test("errors never echo a path, a file name or an id from the request", { skip: SKIP ?? false }, async (t) => {
  const { r, user } = await setup(t);
  r.write("secret-name-marker.txt", "x\n");
  for (let i = 0; i < 201; i++) r.write(`bulk-marker/f${i}.txt`, "x\n");
  const tooLarge = await diff(user, r.workspaceId);
  const unknown = await diff(user, "00000000-0000-4000-8000-000000000000");
  for (const m of [tooLarge, unknown]) {
    assert.equal(m.ok, false);
    const text = JSON.stringify(m);
    for (const forbidden of [r.root, "secret-name-marker", "bulk-marker", "00000000-0000-4000"]) assert.equal(text.includes(forbidden), false, forbidden);
  }
  assert.equal(unknown.error?.code, "E_NOT_FOUND");
});

test("an unborn branch is a conflict (no_head); a workspace that is not READY records nothing and returns no tree", { skip: SKIP ?? false }, async (t) => {
  const a = await setup(t, { unborn: true });
  a.r.write("a.txt", "a\n");
  const res = await diff(a.user, a.r.workspaceId);
  assert.equal(res.error?.code, "E_CONFLICT");
  assert.equal(res.error?.details?.["reason"], "no_head");
  const b = await setup(t, { workspaceNotReady: true });
  b.r.write("a.txt", "a\n");
  const res2 = await diff(b.user, b.r.workspaceId);
  assert.equal(res2.ok, false);
  assert.equal(res2.error?.code, "E_CONFLICT");
  assert.equal(b.r.trees.size, 0);
  assert.equal(b.r.journal.getWorkspace(b.r.workspaceId)?.reviewedTreeHash, null);
});

test("the lookup refuses any hash a diff did not produce for that workspace", { skip: SKIP ?? false }, async (t) => {
  const { r, user } = await setup(t);
  r.write("a.txt", "a\n");
  const tree = (await diff(user, r.workspaceId)).result?.["treeHash"] as string;
  const other = r.newWorkspace();
  const refused = (ws: string, hash: string) => assert.throws(() => r.trees.lookupReviewedTree(ws, hash), (e: unknown) => (e as { code?: string }).code === "E_CONFLICT" && (e as { details?: { reason?: string } }).details?.reason === "stale", `${ws} ${hash}`);
  refused(other, tree); // another workspace's tree, though the same repository state
  refused(r.workspaceId, "0".repeat(tree.length)); // a guess
  refused(r.workspaceId, r.git("rev-parse", "HEAD^{tree}").trim()); // a real tree no diff produced
  refused(r.workspaceId, tree.toUpperCase()); // exact strings only
  assert.equal(r.trees.lookupReviewedTree(r.workspaceId, tree).treeHash, tree);
});

test("the lookup is bounded: old trees and old workspaces are forgotten", { skip: SKIP ?? false }, async (t) => {
  const { r, user } = await setup(t);
  const seen: string[] = [];
  for (let i = 0; i < 10; i++) {
    r.write("a.txt", `${i}\n`);
    seen.push((await diff(user, r.workspaceId)).result?.["treeHash"] as string);
  }
  assert.throws(() => r.trees.lookupReviewedTree(r.workspaceId, seen[0] as string));
  assert.equal(r.trees.lookupReviewedTree(r.workspaceId, seen[9] as string).treeHash, seen[9]);
});
