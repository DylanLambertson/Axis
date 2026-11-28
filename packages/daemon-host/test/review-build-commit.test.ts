// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// DC-2: a tree built from a hunk selection is committed by the unchanged axis.git/1.commit, exactly, on the reviewed parent,
// with the person's index kept as DC-0 keeps it in each staging state.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import { gitRig, gitUnavailable, type GitClient, type GitRig } from "./git-rig.js";

const SKIP = gitUnavailable();
const BASE = Array.from({ length: 20 }, (_, i) => `l${i + 1}\n`).join("");
const FIRST = BASE.replace("l2\n", "L2\n");
const TWO = FIRST.replace("l18\n", "L18\n");
const SECOND_ONLY = BASE.replace("l18\n", "L18\n");
const fileId = (p: string): string => createHash("sha256").update(p, "utf8").digest("hex");

async function setup(t: TestContext): Promise<{ r: GitRig; c: GitClient }> {
  const r = await gitRig();
  t.after(() => r.cleanup());
  r.write("a.txt", BASE);
  r.write("b.txt", "b\n");
  r.git("add", "-A");
  r.git("commit", "-q", "-m", "a");
  return { r, c: await r.connect() };
}

/** Selects the first of a.txt's two hunks and builds; returns what `commit` takes. */
async function buildFirst(r: GitRig, c: GitClient) {
  const h = await c.rpc("axis.review", "hunks", { workspaceId: r.workspaceId, fileId: fileId("a.txt") });
  assert.equal(h.ok, true, JSON.stringify(h.error));
  const { head, versionId, hunks } = h.result as { head: string; versionId: string; hunks: Array<{ id: string }> };
  assert.equal(hunks.length, 2);
  const b = await c.rpc("axis.review", "build", { workspaceId: r.workspaceId, head, selection: [{ fileId: fileId("a.txt"), versionId, hunkIds: [hunks[0]?.id] }] });
  assert.equal(b.ok, true, JSON.stringify(b.error));
  const { treeHash, branch } = b.result as { treeHash: string; branch: string };
  return { reviewedTreeHash: treeHash, expectedParent: head, expectedBranch: branch };
}
const commit = (r: GitRig, c: GitClient, req: Record<string, unknown>) => c.rpc("axis.git", "commit", { workspaceId: r.workspaceId, message: "take L2", ...req }, randomUUID());
const status = (r: GitRig): string => r.git("status", "--porcelain", "--", "a.txt", "b.txt").trimEnd();

test("a partial selection is committed exactly: hunk 1 and not hunk 2, the other file unchanged, on the reviewed head", { skip: SKIP ?? false }, async (t) => {
  const { r, c } = await setup(t);
  r.write("a.txt", TWO);
  const req = await buildFirst(r, c);
  const res = await commit(r, c, req);
  assert.equal(res.ok, true, JSON.stringify(res.error));
  const sha = (res.result as { commit: string }).commit;
  assert.equal(r.git("show", `${sha}:a.txt`), FIRST);
  assert.equal(r.git("show", `${sha}:b.txt`), "b\n");
  assert.equal(r.git("rev-parse", `${sha}^`).trim(), req.expectedParent);
  assert.equal(r.head(), sha);
  // DC-0, nothing staged: the refresh moved the index entry to the commit; the unselected edit stays unstaged, every byte kept.
  assert.equal(status(r), " M a.txt");
  assert.equal(r.git("diff").includes("+L18"), true);
  assert.equal((await import("node:fs")).readFileSync(`${r.repo}/a.txt`, "utf8"), TWO);
});

test("DC-0 staging states: both edits staged stays staged as the remaining edit; only the unselected edit staged is kept as staged", { skip: SKIP ?? false }, async (t) => {
  const { r, c } = await setup(t);
  r.write("a.txt", TWO);
  r.git("add", "a.txt");
  const both = await commit(r, c, await buildFirst(r, c));
  assert.equal(both.ok, true, JSON.stringify(both.error));
  assert.equal(status(r), "M  a.txt", "the index kept the person's staging: only hunk 2 is left staged");
  assert.equal(r.git("diff", "--cached").includes("+L18"), true);

  // Start again from a commit of the base, with only the unselected edit staged.
  r.write("a.txt", BASE);
  r.git("add", "a.txt");
  r.git("commit", "-q", "-m", "back");
  r.write("a.txt", SECOND_ONLY);
  r.git("add", "a.txt");
  r.write("a.txt", TWO);
  const one = await commit(r, c, await buildFirst(r, c));
  assert.equal(one.ok, true, JSON.stringify(one.error));
  // The exact index the person made is kept: it now shows the selected edit reversed and the unselected one, both staged.
  assert.equal(status(r), "MM a.txt");
  assert.equal(r.git("show", ":a.txt"), SECOND_ONLY, "no byte of the person's staging was lost");
});

test("a file edited after the build, selected or not, makes the commit stale", { skip: SKIP ?? false }, async (t) => {
  const { r, c } = await setup(t);
  r.write("a.txt", TWO);
  const req = await buildFirst(r, c);
  r.write("b.txt", "edited after the build\n");
  const res = await commit(r, c, req);
  assert.equal(res.error?.code, "E_CONFLICT", JSON.stringify(res.error));
  assert.equal(res.error?.details?.["reason"], "stale");
  assert.equal(r.head(), req.expectedParent);
});
