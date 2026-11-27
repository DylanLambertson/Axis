// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// DC-0 slice 2 (ADR 0011 Decision 3): when the post-commit refresh does nothing. A held lock, HEAD moved under the lock, a
// split or sparse index, a sparse checkout, unmerged entries, a case collision, a failed rename and a failure after the lock
// was taken each leave the real index byte-identical and never leave Axis's lock behind. A linked worktree changes only its
// own index. The git answers the flags are read from are pinned to their exact shape: `rev-parse --shared-index-path`
// (git 2.13), `diff-index --ita-*-in-index` (2.17) and `ls-files -v -t`; the floor is git 2.24 (MIN_GIT_VERSION).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseTaggedListing, refreshIndex, type WorktreeRef } from "../src/index.js";
import { commitOnTop, entries, indexBytes, indexPath } from "./indexFixture.js";
import { fixture, stage, type Fixture } from "./realFixture.js";

const posix = process.platform !== "win32";
const lock = (f: Fixture): string => `${indexPath(f)}.lock`;

async function untouched(f: Fixture, skipped: string, setup: (f: Fixture) => void, hooks: Parameters<typeof refreshIndex>[4] = {}): Promise<void> {
  setup(f);
  const { old, next } = commitOnTop(f, { "a.txt": "axis\n" });
  const before = indexBytes(f);
  assert.deepEqual(await refreshIndex(f.deps, f.wt, old, next, hooks), { skipped }, skipped);
  assert.deepEqual(indexBytes(f), before, `${skipped}: the index is byte-identical`);
}

test("a held index.lock is a skip without error, and the lock is not Axis's to remove (kills a lock taken without O_EXCL)", { skip: !posix }, async () => {
  const f = fixture();
  await untouched(f, "locked", () => writeFileSync(lock(f), "someone else's\n"));
  assert.equal(existsSync(lock(f)), true);
});

test("HEAD moved after the compare-and-swap, seen under the lock: skipped, lock removed (kills no re-check of HEAD)", { skip: !posix }, async () => {
  const f = fixture();
  await untouched(f, "head_moved", () => undefined, { afterLock: () => void f.git("update-ref", "refs/heads/axis/feat", f.git("rev-parse", "HEAD~1").trim()) });
  assert.equal(existsSync(lock(f)), false);
});

test("a split index, a sparse index and a sparse checkout are skipped whole", { skip: !posix }, async () => {
  await untouched(fixture(), "split_index", (f) => void f.git("update-index", "--split-index"));
  await untouched(fixture(), "split_index", (f) => void f.git("config", "core.splitIndex", "true"));
  await untouched(fixture(), "sparse", (f) => void f.git("config", "core.sparseCheckout", "true"));
  await untouched(fixture(), "sparse", (f) => void f.git("config", "index.sparse", "true"));
});

test("an index with an unmerged entry is skipped whole (kills no unmerged check)", { skip: !posix }, async () => {
  await untouched(fixture(), "unmerged", (f) => {
    const blob = f.git("hash-object", "-w", "--stdin").trim();
    f.git("update-index", "--force-remove", "a.txt");
    for (const s of [1, 2, 3]) execGit(f, ["update-index", "--index-info"], `100644 ${blob} ${s}\ta.txt\n`);
  });
});

test("core.ignorecase: a new entry that would collide with another entry's name is not added (kills no collision check)", { skip: !posix }, async () => {
  const f = fixture();
  f.git("config", "core.ignorecase", "true");
  stage(f, "Notes.txt", "n\n");
  f.git("commit", "-q", "-m", "notes");
  const { old, next } = commitOnTop(f, { "notes.TXT": "other\n", "a.txt": "axis\n" });
  const r = await refreshIndex(f.deps, f.wt, old, next);
  assert.deepEqual(r, { refreshed: 1 }, "only a.txt");
  assert.equal(entries(f).has("notes.TXT"), false);
});

test("a failed rename and a failure after the lock was taken: the lock is removed and the index is byte-identical", { skip: !posix }, async () => {
  const f = fixture();
  await untouched(f, "rename_failed", () => undefined, { rename: async () => { throw new Error("EPERM"); } });
  assert.equal(existsSync(lock(f)), false, "kills a lock left behind on a failed rename");
  const g = fixture();
  await untouched(g, "failed", () => undefined, { afterLock: () => { throw new Error("crash"); } });
  assert.equal(existsSync(lock(g)), false, "kills a lock left behind on a failure");
});

test("a linked worktree's refresh changes its own index only", { skip: !posix }, async () => {
  const f = fixture();
  const other = join(f.root, "linked");
  f.git("worktree", "add", "-q", "-b", "axis/other", other);
  const main = indexBytes(f);
  const linked: Fixture = { ...f, wt: { workTree: other, gitDir: join(f.wt.gitDir, "worktrees", "linked") } as WorktreeRef, git: (...a: string[]) => f.run(other, ...a) };
  const { old, next } = commitOnTop(linked, { "a.txt": "axis\n" }, "axis/other");
  assert.deepEqual(await refreshIndex(f.deps, linked.wt, old, next), { refreshed: 1 });
  assert.deepEqual(indexBytes(f), main, "the main worktree's index is byte-identical");
  assert.equal(linked.git("ls-files", "--stage", "a.txt").split(" ")[1], linked.git("rev-parse", "HEAD:a.txt").trim());
});

test("the git answers the flags come from have exactly the shape the reader expects (fails loudly if git changes them)", { skip: !posix }, () => {
  const f = fixture();
  stage(f, "s.txt", "s\n");
  stage(f, "e.txt", "");
  f.git("commit", "-q", "-m", "flags");
  f.git("update-index", "--skip-worktree", "s.txt");
  f.git("update-index", "--assume-unchanged", "a.txt");
  f.git("rm", "-q", "--cached", "e.txt");
  f.git("add", "-N", "e.txt");
  writeFileSync(join(f.wt.workTree, "new.txt"), "");
  f.git("add", "-N", "new.txt");
  const version = f.git("--version").trim();
  const listed = f.git("ls-files", "-v", "-t", "--stage", "-z");
  assert.match(listed, /^(?:[HSMhsm] [0-7]{6} [0-9a-f]{40,64} [0-3]\t[^\0]+\0)+$/, `${version}: the ls-files -v -t answer changed shape; the refresh must be revisited`);
  const tags = new Map(listed.split("\0").filter((r) => r !== "").map((r) => [r.slice(r.indexOf("\t") + 1), r[0]]));
  assert.deepEqual([tags.get("a.txt"), tags.get("s.txt"), tags.get("e.txt")], ["h", "S", "H"], "assume-unchanged is lower case, skip-worktree is S, intent-to-add has no tag");
  const none = execFileSync("git", ["mktree"], { cwd: f.wt.workTree, env: f.env, input: "", encoding: "utf8" }).trim();
  const list = (o: string) => f.git("diff-index", "--cached", "--name-only", "-z", "--no-renames", o, none).split("\0").filter((n) => n !== "").sort();
  const all = ["a.txt", "e.txt", "new.txt", "s.txt"];
  assert.deepEqual([list("--ita-visible-in-index"), list("--ita-invisible-in-index")], [all, ["a.txt", "s.txt"]], `${version}: against the empty tree, intent-to-add is exactly where the two answers disagree`);
  assert.equal(parseTaggedListing(Buffer.from(listed, "utf8").toString("latin1"))?.get("s.txt")?.flagged, true);
  assert.equal(parseTaggedListing("X 100644 " + "0".repeat(40) + " 0\tq\0"), undefined, "an unknown tag is not guessed");
});

function execGit(f: Fixture, args: string[], input: string): void {
  execFileSync("git", args, { cwd: f.wt.workTree, env: f.env, input });
}

test("S2: a held lock is retried once after a short wait; a lock released by then is refreshed, one still held is a skip", { skip: !posix }, async () => {
  const f = fixture();
  const { old, next } = commitOnTop(f, { "a.txt": "axis\n" });
  writeFileSync(lock(f), "an IDE's background status\n");
  const waits: number[] = [];
  const r = await refreshIndex(f.deps, f.wt, old, next, { wait: async (ms) => { waits.push(ms); rmSync(lock(f)); } });
  assert.deepEqual([r, waits.length], [{ refreshed: 1 }, 1], "kills no retry");
  const g = fixture();
  const c = commitOnTop(g, { "a.txt": "axis\n" });
  writeFileSync(lock(g), "held\n");
  let n = 0;
  assert.deepEqual(await refreshIndex(g.deps, g.wt, c.old, c.next, { wait: async () => void n++ }), { skipped: "locked" });
  assert.equal(n, 1, "one retry only");
});

test("N2: a symlinked index is skipped, the link and its target unchanged", { skip: !posix }, async () => {
  const f = fixture();
  const target = join(f.root, "index-elsewhere");
  renameSync(indexPath(f), target);
  symlinkSync(target, indexPath(f));
  const before = readFileSync(target);
  const { old, next } = commitOnTop(f, { "a.txt": "axis\n" });
  assert.deepEqual(await refreshIndex(f.deps, f.wt, old, next), { skipped: "symlink" });
  assert.equal(lstatSync(indexPath(f)).isSymbolicLink(), true);
  assert.deepEqual(readFileSync(target), before);
});
