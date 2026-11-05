// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Findings of the independent review, part one: content filters (B1), an operation in progress (B2), the parent pin (S1).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createNodeRunner, executeCommit, type GitRunRequest } from "@axis/git-ops";
import { ReviewError, ReviewSession, prepareCommit } from "../src/index.js";
import { fixture, refusal, type Fixture } from "./fixture.js";
import { PASS, POINTER, REVERSE, withFilter } from "./filters.js";

const posix = process.platform !== "win32";
const BASE = Array.from({ length: 20 }, (_, i) => `l${i + 1}\n`).join("");

for (const [name, clean, expected] of [
  ["a clean filter that encrypts", REVERSE, "\ndlrow olleh"],
  ["an LFS-style pointer filter", POINTER, undefined],
] as const) {
  test(`${name}: an untouched filtered file is never offered, and the commit keeps the stored blob`, { skip: !posix }, async () => {
    const f = fixture({ base: withFilter(clean, PASS) });
    try {
      const stored = f.git("rev-parse", "HEAD:vault.dat").trim();
      if (expected !== undefined) assert.equal(f.git("cat-file", "blob", stored), expected, "the stored blob is the cleaned one");
      assert.equal(f.git("status", "--porcelain").trim(), "", "git itself sees nothing changed");
      f.write("a.txt", BASE.replace("l2\n", "L2\n"));
      const s = await ReviewSession.start(f.deps, { worktree: f.wt, against: f.head() });
      const v = s.file("vault.dat");
      assert.equal(v.kind, "filtered");
      assert.equal(v.fileLevelReason, "filtered_path");
      assert.throws(() => s.acceptFile("vault.dat"), (e: unknown) => e instanceof ReviewError && e.details?.["reason"] === "filtered_path");
      s.acceptFile("a.txt");
      const b = await s.build();
      assert.equal(f.git("rev-parse", `${b.reviewedTree}:vault.dat`).trim(), stored, "the reviewed tree keeps the stored blob");
      const prepared = await prepareCommit(f.deps, b);
      await executeCommit(f.gitOps, await prepared.handoff("change a"));
      assert.equal(f.git("rev-parse", "HEAD:vault.dat").trim(), stored, "the commit does not replace it with the worktree bytes");
    } finally {
      f.cleanup();
    }
  });
}

test("a filtered path is flagged for a delete and an add too, and the filter does not run in the daemon", { skip: !posix }, async () => {
  const mark = `require("node:fs").writeFileSync(require("node:path").join(__dirname,"ran"),"x");`;
  const f = fixture({ base: withFilter(mark + PASS, PASS) });
  try {
    const ran = join(f.root, "ran");
    assert.equal(existsSync(ran), true, "control: the filter ran when git added the file");
    rmSync(ran);
    rmSync(join(f.repo, "vault.dat"));
    f.write("moved.dat", "other\n");
    f.write("fresh.txt", "x\n");
    const s = await ReviewSession.start(f.deps, { worktree: f.wt, against: f.head() });
    assert.equal(existsSync(ran), false, "the review did not run the clean filter");
    assert.equal(s.file("vault.dat").kind, "filtered");
    assert.equal(s.file("moved.dat").kind, "filtered");
    assert.equal(s.file("fresh.txt").kind, "text");
  } finally {
    f.cleanup();
  }
});

/** Runs git and returns normally whether or not it succeeds: a conflicting merge exits 1 on purpose. */
function tryGit(f: Fixture, ...args: string[]): void {
  try {
    f.git(...args);
  } catch {
    /* a conflict is the point */
  }
}

function conflictState(f: Fixture, how: "merge" | "cherry-pick" | "revert"): void {
  f.git("checkout", "-q", "-b", "other");
  f.write("a.txt", BASE.replace("l2\n", "O2\n"));
  f.write("other.txt", "other\n");
  f.git("add", "-A");
  f.git("commit", "-q", "-m", "other side");
  f.git("checkout", "-q", "axis/feat");
  f.write("a.txt", BASE.replace("l2\n", "F2\n"));
  f.git("commit", "-q", "-a", "-m", "feature side");
  if (how === "revert") {
    f.write("a.txt", BASE.replace("l2\n", "G2\n"));
    f.git("commit", "-q", "-a", "-m", "later");
    tryGit(f, "revert", "--no-edit", "HEAD~1");
  } else tryGit(f, how, how === "merge" ? "--no-edit" : "other", ...(how === "merge" ? ["other"] : []));
}

for (const [how, file] of [["merge", "MERGE_HEAD"], ["cherry-pick", "CHERRY_PICK_HEAD"], ["revert", "REVERT_HEAD"]] as const) {
  test(`prepare refuses while a ${how} is in progress, before and after the user stages the resolution`, async () => {
    const f = fixture();
    try {
      conflictState(f, how);
      assert.ok(existsSync(join(f.repo, ".git", file)), `${file} exists`);
      f.write("a.txt", BASE.replace("l2\n", "R2\n"));
      const s = await ReviewSession.start(f.deps, { worktree: f.wt, against: f.head() });
      s.acceptFile("a.txt");
      const b = await s.build();
      const before = f.git("ls-files", "-u");
      const e = await refusal(prepareCommit(f.deps, b));
      assert.equal(e.code, "E_CONFLICT");
      assert.equal(e.details?.["reason"], "operation_in_progress");
      assert.equal(f.git("ls-files", "-u"), before, "the unmerged entries are still in the index");
      f.git("add", "a.txt");
      assert.equal((await refusal(prepareCommit(f.deps, b))).details?.["reason"], "operation_in_progress", `${file} alone is enough`);
    } finally {
      f.cleanup();
    }
  });
}

for (const marker of ["rebase-merge", "rebase-apply", "sequencer", "BISECT_LOG", "BISECT_START"]) {
  test(`prepare refuses when ${marker} exists in the git directory`, async () => {
    const f = fixture();
    try {
      f.write("a.txt", BASE.replace("l2\n", "L2\n"));
      const s = await ReviewSession.start(f.deps, { worktree: f.wt, against: f.head() });
      s.acceptFile("a.txt");
      const b = await s.build();
      if (marker.includes("-")) mkdirSync(join(f.repo, ".git", marker));
      else writeFileSync(join(f.repo, ".git", marker), "x\n");
      assert.equal((await refusal(prepareCommit(f.deps, b))).details?.["reason"], "operation_in_progress");
    } finally {
      f.cleanup();
    }
  });
}

test("prepare checks the git directory of a linked worktree, not the main one", { skip: !posix }, async () => {
  const f = fixture();
  try {
    const wtDir = join(f.root, "linked");
    f.git("worktree", "add", "-q", "-b", "axis/linked", wtDir);
    const gitDir = f.git("-C", wtDir, "rev-parse", "--absolute-git-dir").trim();
    writeFileSync(join(wtDir, "a.txt"), BASE.replace("l2\n", "L2\n"));
    const wt = { workTree: wtDir, gitDir };
    const s = await ReviewSession.start(f.deps, { worktree: wt, against: f.git("-C", wtDir, "rev-parse", "HEAD").trim() });
    s.acceptFile("a.txt");
    const b = await s.build();
    writeFileSync(join(gitDir, "MERGE_HEAD"), `${f.head()}\n`);
    assert.equal((await refusal(prepareCommit(f.deps, b))).details?.["reason"], "operation_in_progress");
  } finally {
    f.cleanup();
  }
});

/** A runner that runs `after` once the real index has been written by `read-tree` (the staging step of prepare). */
function afterStaging(f: Fixture, act: () => void): Fixture["gitOps"] {
  const inner = createNodeRunner({ allowPtyContext: true });
  let done = false;
  return {
    ...f.gitOps,
    runner: {
      async run(req: GitRunRequest) {
        const r = await inner.run(req);
        if (!done && req.argv.includes("read-tree") && req.env["GIT_INDEX_FILE"] === undefined) {
          done = true;
          act();
        }
        return r;
      },
    },
  };
}

test("prepare re-checks the operation and HEAD after it staged the tree", async () => {
  for (const act of [(f: Fixture) => writeFileSync(join(f.repo, ".git", "MERGE_HEAD"), `${f.head()}\n`), (f: Fixture) => {
    const c = f.git("commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "foreign").trim();
    f.git("update-ref", "refs/heads/axis/feat", c);
  }]) {
    const f = fixture();
    try {
      f.write("a.txt", BASE.replace("l2\n", "L2\n"));
      const s = await ReviewSession.start(f.deps, { worktree: f.wt, against: f.head() });
      s.acceptFile("a.txt");
      const b = await s.build();
      const e = await refusal(prepareCommit({ ...f.deps, git: afterStaging(f, () => act(f)) }, b));
      assert.equal(e.code, "E_CONFLICT");
    } finally {
      f.cleanup();
    }
  }
});

test("the hand-over refuses when HEAD moved after prepare, and carries the parent and branch it expects", async () => {
  const f = fixture();
  try {
    f.write("a.txt", BASE.replace("l2\n", "L2\n"));
    f.write("keep.txt", "staged elsewhere\n");
    f.git("add", "keep.txt");
    const staged = f.git("write-tree").trim();
    const s = await ReviewSession.start(f.deps, { worktree: f.wt, against: f.head() });
    s.acceptFile("a.txt");
    const b = await s.build();
    const prepared = await prepareCommit(f.deps, b);
    assert.equal(prepared.previousIndexTree, staged, "the user's staging can be put back if the commit is refused");
    const input = await prepared.handoff("m");
    assert.equal(input.expectedParent, b.head);
    assert.equal(input.expectedBranch, "refs/heads/axis/feat");
    const c = f.git("commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "foreign").trim();
    f.git("update-ref", "refs/heads/axis/feat", c);
    const e = await refusal(prepared.handoff("m"));
    assert.equal(e.code, "E_CONFLICT");
    assert.equal(e.details?.["reason"], "head_moved");
    assert.ok(e instanceof ReviewError);
  } finally {
    f.cleanup();
  }
});
