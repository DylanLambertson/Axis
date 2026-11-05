// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// REV-1: the binding, staleness, and the hand-over to @axis/git-ops commit (design §6).
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GitOpsError, executeCommit, planCommit } from "@axis/git-ops";
import { ReviewSession, checkFresh, prepareCommit, type ReviewBinding } from "../src/index.js";
import { fixture, refusal, type Fixture } from "./fixture.js";

const posix = process.platform !== "win32";
const BASE = Array.from({ length: 20 }, (_, i) => `l${i + 1}\n`).join("");

async function reviewed(f: Fixture, accept: (s: ReviewSession) => Promise<void> | void): Promise<{ s: ReviewSession; b: ReviewBinding }> {
  const s = await ReviewSession.start(f.deps, { worktree: f.wt, against: f.head() });
  await accept(s);
  return { s, b: await s.build() };
}
const twoEdits = (f: Fixture): string => {
  const edited = BASE.replace("l2\n", "L2\n").replace("l18\n", "L18\n");
  f.write("a.txt", edited);
  return edited;
};

test("review, partial accept, prepare and Axis commit: the commit holds exactly the reviewed tree", async () => {
  const f = fixture();
  try {
    const edited = twoEdits(f);
    const { b } = await reviewed(f, async (s) => s.acceptHunk("a.txt", (await s.hunks("a.txt")).hunks?.[0]?.id ?? ""));
    const prepared = await prepareCommit(f.deps, b);
    assert.equal(prepared.reviewedTreeHash, b.reviewedTree);
    assert.equal(f.git("write-tree").trim(), b.reviewedTree, "the real index now holds the reviewed tree");
    const result = await executeCommit(f.gitOps, await prepared.handoff("accept the first hunk"));
    assert.equal(result.tree, b.reviewedTree);
    assert.equal(f.git("rev-parse", "HEAD^{tree}").trim(), b.reviewedTree);
    assert.equal(f.git("rev-parse", "HEAD~1").trim(), b.head);
    assert.equal(readFileSync(join(f.repo, "a.txt"), "utf8"), edited, "the rejected hunk is still in the worktree, unstaged");
    assert.match(f.git("diff", "--stat"), /a\.txt \| 2 \+-/);
    assert.equal(f.git("log", "-1", "--format=%an <%ae>").trim(), "Dylan Lambertson <me@dylanlambertson.dev>");
  } finally {
    f.cleanup();
  }
});

test("Axis commit alone refuses a reviewed tree that was never staged: the prepare step is what stages it", async () => {
  const f = fixture();
  try {
    twoEdits(f);
    const { b } = await reviewed(f, async (s) => s.acceptHunk("a.txt", (await s.hunks("a.txt")).hunks?.[0]?.id ?? ""));
    const raw = { worktree: f.wt, reviewedTreeHash: b.reviewedTree, message: "m", expectedParent: f.head(), expectedBranch: "axis/feat" };
    const e = await refusal2(executeCommit(f.gitOps, raw));
    assert.equal(e.code, "E_CONFLICT");
    assert.match(e.message, /index differs from the tree that was reviewed/);
  } finally {
    f.cleanup();
  }
});

async function refusal2(p: Promise<unknown>): Promise<GitOpsError> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof GitOpsError, String(e));
    return e;
  }
  assert.fail("expected a refusal");
}

test("a file edited after review makes the commit refuse, names the path, and leaves the index alone", async () => {
  const f = fixture();
  try {
    twoEdits(f);
    const { b } = await reviewed(f, (s) => s.acceptFile("a.txt"));
    const indexBefore = f.git("write-tree").trim();
    f.write("a.txt", `${BASE}late edit\n`);
    const fresh = await checkFresh(f.deps, b);
    assert.deepEqual(fresh, { fresh: false, reason: "stale", changedCount: 1, changedPaths: ["a.txt"] });
    const e = await refusal(prepareCommit(f.deps, b));
    assert.equal(e.code, "E_CONFLICT");
    assert.equal(e.details?.["reason"], "stale");
    assert.equal(f.git("write-tree").trim(), indexBefore, "nothing was staged");
  } finally {
    f.cleanup();
  }
});

test("a new file, a deleted file and an unreviewed file each make the review stale, and an untouched file does not", async () => {
  const f = fixture();
  try {
    f.write("a.txt", BASE.replace("l2\n", "L2\n"));
    const { b } = await reviewed(f, (s) => s.acceptFile("a.txt"));
    assert.deepEqual(await checkFresh(f.deps, b), { fresh: true });
    // Rewriting the same bytes (new mtime) is not a change.
    writeFileSync(join(f.repo, "a.txt"), BASE.replace("l2\n", "L2\n"));
    assert.deepEqual(await checkFresh(f.deps, b), { fresh: true });
    f.write("new\nname.txt", "n\n");
    const one = await checkFresh(f.deps, b);
    assert.equal(one.fresh, false);
    assert.deepEqual(one.fresh === false && one.changedPaths, ["new\\nname.txt"], "the changed path is escaped for display");
    unlinkSync(join(f.repo, "new\nname.txt"));
    unlinkSync(join(f.repo, "keep.txt"));
    assert.equal((await checkFresh(f.deps, b)).fresh, false);
  } finally {
    f.cleanup();
  }
});

test("a reviewed file swapped for a symlink to a file outside before accept: the tree has the reviewed bytes and the commit refuses", { skip: !posix }, async () => {
  const f = fixture();
  try {
    const outside = join(f.root, "outside-file.txt");
    writeFileSync(outside, "OUTSIDE-CONTENT\n");
    const edited = BASE.replace("l2\n", "L2\n");
    f.write("a.txt", edited);
    const s = await ReviewSession.start(f.deps, { worktree: f.wt, against: f.head() });
    unlinkSync(join(f.repo, "a.txt"));
    symlinkSync(outside, join(f.repo, "a.txt"));
    s.acceptFile("a.txt");
    const b = await s.build();
    assert.equal(f.git("cat-file", "blob", `${b.reviewedTree}:a.txt`), edited, "accept used the immutable objects, not the swapped file");
    assert.doesNotMatch(f.git("cat-file", "-p", b.reviewedTree), /outside/i);
    const e = await refusal(prepareCommit(f.deps, b));
    assert.equal(e.details?.["reason"], "stale");
    // A fresh review sees the link as a link and never reads what it points at.
    const again = await ReviewSession.start(f.deps, { worktree: f.wt, against: f.head() });
    const link = again.files.find((x) => x.path === "a.txt");
    assert.equal(link?.status, "T");
    assert.equal(link?.link?.escapesWorktree, true);
    const preview = await again.preview("a.txt", "new");
    assert.equal(preview.kind, "symlink");
    assert.doesNotMatch(JSON.stringify(preview), /OUTSIDE-CONTENT/);
    assert.equal(f.git("ls-tree", again.worktreeTree, "a.txt").startsWith("120000"), true);
    assert.doesNotMatch(f.git("cat-file", "blob", f.git("rev-parse", `${again.worktreeTree}:a.txt`).trim()), /OUTSIDE-CONTENT/);
  } finally {
    f.cleanup();
  }
});

test("a directory replaced by a symlink to a directory outside is a link entry, not a way out", { skip: !posix }, async () => {
  const f = fixture({ base: ({ write }) => write("d/file.txt", "inner\n") });
  try {
    const out = join(f.root, "outside-dir");
    mkdirSync(out);
    writeFileSync(join(out, "file.txt"), "OUTSIDE\n");
    rmSync(join(f.repo, "d"), { recursive: true });
    symlinkSync(out, join(f.repo, "d"));
    const s = await ReviewSession.start(f.deps, { worktree: f.wt, against: f.head() });
    assert.deepEqual(s.files.map((x) => [x.path, x.status]).sort(), [["d", "A"], ["d/file.txt", "D"]]);
    for (const x of s.files) s.acceptFile(x.path);
    const b = await s.build();
    assert.doesNotMatch(f.git("ls-tree", "-r", b.reviewedTree), /outside/i);
    assert.equal(f.git("ls-tree", b.reviewedTree, "d").startsWith("120000"), true);
  } finally {
    f.cleanup();
  }
});

test("HEAD moving after the review refuses the commit even when no file changed", async () => {
  const f = fixture();
  try {
    f.write("a.txt", BASE.replace("l2\n", "L2\n"));
    const { b } = await reviewed(f, (s) => s.acceptFile("a.txt"));
    f.git("commit", "-q", "--allow-empty", "-m", "someone else");
    assert.deepEqual(await checkFresh(f.deps, b), { fresh: false, reason: "head_moved", changedPaths: [], changedCount: 0 });
    const e = await refusal(prepareCommit(f.deps, b));
    assert.equal(e.details?.["reason"], "head_moved");
  } finally {
    f.cleanup();
  }
});

test("switching to another branch at the same commit refuses the commit too", async () => {
  const f = fixture();
  try {
    f.write("a.txt", BASE.replace("l2\n", "L2\n"));
    const { b } = await reviewed(f, (s) => s.acceptFile("a.txt"));
    f.git("checkout", "-q", "-b", "axis/other");
    assert.equal((await checkFresh(f.deps, b)).fresh, false);
    assert.equal((await refusal(prepareCommit(f.deps, b))).details?.["reason"], "head_moved");
    f.git("checkout", "-q", "--detach");
    assert.equal((await refusal(prepareCommit(f.deps, b))).details?.["reason"], "head_moved");
    f.git("checkout", "-q", "axis/feat");
    assert.deepEqual(await checkFresh(f.deps, b), { fresh: true });
  } finally {
    f.cleanup();
  }
});

test("a SHA-256 repository works end to end", async (t) => {
  let f: Fixture;
  try {
    f = fixture({ objectFormat: "sha256" });
  } catch {
    t.skip("this git cannot create a SHA-256 repository");
    return;
  }
  try {
    f.write("a.txt", BASE.replace("l2\n", "L2\n").replace("l18\n", "L18\n"));
    const { b, s } = await reviewed(f, async (x) => x.acceptHunk("a.txt", (await x.hunks("a.txt")).hunks?.[0]?.id ?? ""));
    assert.equal(b.reviewedTree.length, 64);
    assert.equal(f.git("cat-file", "blob", `${b.reviewedTree}:a.txt`), BASE.replace("l2\n", "L2\n"));
    assert.equal(s.files[0]?.oldOid.length, 64);
    const prepared = await prepareCommit(f.deps, b);
    assert.equal((await executeCommit(f.gitOps, await prepared.handoff("m"))).tree, b.reviewedTree);
  } finally {
    f.cleanup();
  }
});

test("a binding that this package did not mint is refused, however it is built", async () => {
  const f = fixture();
  try {
    f.write("a.txt", BASE.replace("l2\n", "L2\n"));
    const { b } = await reviewed(f, (s) => s.acceptFile("a.txt"));
    const plain = { ...b };
    const sameProto = Object.create(Object.getPrototypeOf(b), Object.getOwnPropertyDescriptors(b)) as ReviewBinding;
    for (const fake of [plain, sameProto, null, undefined, 7, {}]) {
      const e = await refusal(prepareCommit(f.deps, fake as unknown as ReviewBinding));
      assert.equal(e.code, "E_INVALID_ARGUMENT");
      assert.equal((await refusal(checkFresh(f.deps, fake as unknown as ReviewBinding))).code, "E_INVALID_ARGUMENT");
    }
  } finally {
    f.cleanup();
  }
});

test("git-ops refuses what the review layer prepared if the index is changed between prepare and commit", async () => {
  const f = fixture();
  try {
    f.write("a.txt", BASE.replace("l2\n", "L2\n"));
    const { b } = await reviewed(f, (s) => s.acceptFile("a.txt"));
    const prepared = await prepareCommit(f.deps, b);
    f.write("evil.txt", "x\n");
    f.git("add", "evil.txt");
    assert.equal((await refusal(prepared.handoff("m"))).details?.["reason"], "index_changed", "the hand-over notices first");
    const raw = { worktree: f.wt, reviewedTreeHash: b.reviewedTree, message: "m", expectedParent: f.head(), expectedBranch: "axis/feat" };
    const e = await refusal2(executeCommit(f.gitOps, raw));
    assert.equal(e.code, "E_CONFLICT");
    const plan = await refusal2(planCommit(f.gitOps, raw));
    assert.equal(plan.code, "E_CONFLICT");
  } finally {
    f.cleanup();
  }
});

test("a sparse checkout is refused rather than losing its skip-worktree state", async () => {
  const f = fixture();
  try {
    f.write("a.txt", BASE.replace("l2\n", "L2\n"));
    const { b } = await reviewed(f, (s) => s.acceptFile("a.txt"));
    f.git("config", "core.sparseCheckout", "true");
    assert.equal((await refusal(prepareCommit(f.deps, b))).code, "E_UNAVAILABLE");
  } finally {
    f.cleanup();
  }
});

test("repository hooks never run in any review operation", { skip: !posix }, async () => {
  const f = fixture();
  try {
    const marker = join(f.root, "marker");
    mkdirSync(join(f.wt.gitDir, "hooks"), { recursive: true });
    for (const h of ["post-index-change", "reference-transaction", "pre-commit", "post-checkout", "fsmonitor-watchman"]) {
      const p = join(f.wt.gitDir, "hooks", h);
      writeFileSync(p, `#!/bin/sh\necho ${h} >> "${marker}"\nexit 0\n`);
      chmodSync(p, 0o755);
    }
    f.git("config", "core.fsmonitor", join(f.wt.gitDir, "hooks", "fsmonitor-watchman"));
    f.write("a.txt", BASE.replace("l2\n", "L2\n"));
    const { b } = await reviewed(f, (s) => s.acceptFile("a.txt"));
    await checkFresh(f.deps, b);
    await prepareCommit(f.deps, b);
    assert.equal(existsSync(marker), false, existsSync(marker) ? readFileSync(marker, "utf8") : "");
    // Control: the same hooks do run when git is asked to run them, so the assertion above is not vacuous.
    f.git("checkout", "-q", "-b", "control");
    assert.equal(existsSync(marker), true, "the planted hooks are live");
  } finally {
    f.cleanup();
  }
});
