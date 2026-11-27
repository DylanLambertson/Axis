// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// DC-0 slice 2 (ADR 0011 Decision 3): the narrow refresh of the real index after an Axis commit, in real repositories. Only
// the paths the commit changed, only an entry exactly equal to old HEAD (stage 0, mode, object id; absent in both is equal),
// never an entry with skip-worktree, assume-unchanged or intent-to-add, never one the user staged. Each case names its mutant.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { executeCommit, refreshIndex } from "../src/index.js";
import { commitOnTop, debugOf, entries, headEntries, indexBytes, indexMode } from "./indexFixture.js";
import { fixture, pin, stage } from "./realFixture.js";

const posix = process.platform !== "win32";

test("an index equal to old HEAD becomes new HEAD on the changed paths: edited, added, deleted, a mode change, a symlink, a gitlink", { skip: !posix }, async () => {
  const f = fixture();
  stage(f, "c.txt", "gone soon\n");
  f.git("commit", "-q", "-m", "c");
  const gitlink = f.git("rev-parse", "HEAD").trim();
  const { old, next } = commitOnTop(f, {
    "a.txt": "two\n",
    "b.txt": "new\n",
    "c.txt": null,
    "x.sh": { mode: "100755", text: "#!/bin/sh\n" },
    "l": { mode: "120000", text: "a.txt" },
    "sub": { mode: "160000", oid: gitlink },
  });
  const r = await refreshIndex(f.deps, f.wt, old, next);
  assert.deepEqual(r, { refreshed: 6 });
  assert.deepEqual(entries(f), headEntries(f), "every changed path is new HEAD's entry, and only those changed");
});

test("the user's own staging is kept byte for byte: a staged edit, a staged mode change, a git rm --cached; equal paths beside them are refreshed", { skip: !posix }, async () => {
  const f = fixture();
  stage(f, "b.txt", "b\n");
  stage(f, "c.txt", "c\n");
  stage(f, "d.txt", "d\n");
  f.git("commit", "-q", "-m", "bcd");
  writeFileSync(join(f.wt.workTree, "a.txt"), "the user's edit\n");
  f.git("add", "a.txt");
  f.git("update-index", "--chmod=+x", "b.txt");
  f.git("rm", "-q", "--cached", "c.txt");
  const kept = { a: debugOf(f, "a.txt"), b: debugOf(f, "b.txt") };
  const { old, next } = commitOnTop(f, { "a.txt": "axis\n", "b.txt": "axis b\n", "c.txt": "axis c\n", "d.txt": "axis d\n" });
  const r = await refreshIndex(f.deps, f.wt, old, next);
  assert.deepEqual(r, { refreshed: 1 }, "only d.txt");
  assert.equal(debugOf(f, "a.txt"), kept.a, "a staged edit: kills an equality that ignores the object id");
  assert.equal(debugOf(f, "b.txt"), kept.b, "a staged mode change: kills an equality that ignores the mode");
  assert.equal(entries(f).has("c.txt"), false, "git rm --cached stays removed: kills absent-in-the-index counted as equal");
  assert.equal(entries(f).get("d.txt"), headEntries(f).get("d.txt"));
});

test("skip-worktree, assume-unchanged and intent-to-add entries equal to old HEAD are left untouched, flags and all", { skip: !posix }, async () => {
  const f = fixture();
  stage(f, "s.txt", "s\n");
  stage(f, "u.txt", "u\n");
  stage(f, "n.txt", "");
  f.git("commit", "-q", "-m", "flags");
  f.git("update-index", "--skip-worktree", "s.txt");
  f.git("update-index", "--assume-unchanged", "u.txt");
  // An intent-to-add entry has the empty blob and mode 100644: equal to old HEAD's empty n.txt by mode and id alone.
  f.git("rm", "-q", "--cached", "n.txt");
  f.git("add", "-N", "n.txt");
  const kept = ["s.txt", "u.txt", "n.txt"].map((p) => debugOf(f, p));
  const { old, next } = commitOnTop(f, { "s.txt": "S\n", "u.txt": "U\n", "n.txt": "N\n" });
  const r = await refreshIndex(f.deps, f.wt, old, next);
  assert.deepEqual(r, { refreshed: 0 });
  assert.deepEqual(["s.txt", "u.txt", "n.txt"].map((p) => debugOf(f, p)), kept, "kills ignoring each flag");
});

test("a git add landing just before the lock is read under the lock and kept (kills reading the index before taking the lock)", { skip: !posix }, async () => {
  const f = fixture();
  const { old, next } = commitOnTop(f, { "a.txt": "axis\n" });
  const r = await refreshIndex(f.deps, f.wt, old, next, {
    beforeLock: () => {
      writeFileSync(join(f.wt.workTree, "a.txt"), "the user's racing add\n");
      f.git("add", "a.txt");
    },
  });
  assert.deepEqual(r, { refreshed: 0 });
  assert.equal(f.git("cat-file", "-p", `:a.txt`), "the user's racing add\n");
});

test("the index file's mode is kept, and no hook, fsmonitor or clean filter runs", { skip: !posix }, async () => {
  const f = fixture();
  const marker = f.marker;
  const script = join(f.root, "mark.sh");
  writeFileSync(script, `#!/bin/sh\necho "$0 $*" >> "${marker}"\ncat\n`);
  chmodSync(script, 0o755);
  const hooks = join(f.root, "hooks");
  execFileSync("mkdir", ["-p", hooks]);
  symlinkSync(script, join(hooks, "post-index-change"));
  f.git("config", "core.hooksPath", hooks);
  f.git("config", "core.fsmonitor", script);
  f.git("config", "filter.x.clean", script);
  writeFileSync(join(f.wt.gitDir, "info", "attributes"), "*.txt filter=x\n");
  chmodSync(join(f.wt.gitDir, "index"), 0o640);
  const { old, next } = commitOnTop(f, { "a.txt": "axis\n" });
  execFileSync("rm", ["-f", marker]);
  const r = await refreshIndex(f.deps, f.wt, old, next);
  assert.deepEqual(r, { refreshed: 1 });
  assert.equal(indexMode(f), 0o640, "kills dropping the chmod before the rename");
  assert.equal(execFileSync("sh", ["-c", `test -e "${marker}" && cat "${marker}" || true`], { encoding: "utf8" }), "", "no program of the repository ran");
});

test("executeCommit refreshes the index after the compare-and-swap: a clean worktree is clean after the Axis commit", { skip: !posix }, async () => {
  const f = fixture();
  const reviewed = stage(f, "b.txt", "two\n");
  f.git("read-tree", "HEAD");
  const before = indexBytes(f);
  const r = await executeCommit(f.deps, { worktree: f.wt, reviewedTreeHash: reviewed, message: "m", ...pin(f) });
  assert.deepEqual(r.indexRefresh, { refreshed: 1 });
  assert.notDeepEqual(indexBytes(f), before);
  assert.equal(f.git("status", "--porcelain").trim(), "", "nothing shows as a staged reversion");
});

// Review 2 of DC-0.

test("B1: a directory turned into a file keeps the user's staged entry under it, and its flagged entry; an equal one is replaced", { skip: !posix }, async () => {
  for (const setup of ["staged", "flagged", "equal"] as const) {
    const f = fixture();
    mkdirSync(join(f.wt.workTree, "x"));
    stage(f, "x/y", "y\n");
    f.git("commit", "-q", "-m", "x/y");
    if (setup === "staged") {
      writeFileSync(join(f.wt.workTree, "x", "y"), "the user's edit\n");
      f.git("add", "x/y");
    }
    if (setup === "flagged") f.git("update-index", "--skip-worktree", "x/y");
    const kept = debugOf(f, "x/y");
    const { old, next } = commitOnTop(f, { "x/y": null, x: "now a file\n" });
    const r = await refreshIndex(f.deps, f.wt, old, next);
    if (setup === "equal") {
      assert.deepEqual(r, { refreshed: 2 });
      assert.deepEqual(entries(f), headEntries(f));
    } else {
      assert.deepEqual(r, { refreshed: 0 }, `${setup}: kills an add that ignores a staying entry below it`);
      assert.equal(debugOf(f, "x/y"), kept, `${setup}: x/y is still the user's`);
      assert.equal(entries(f).has("x"), false);
    }
  }
});

test("B1: a file turned into a directory keeps the user's staged file", { skip: !posix }, async () => {
  const f = fixture();
  stage(f, "x", "a file\n");
  f.git("commit", "-q", "-m", "x");
  writeFileSync(join(f.wt.workTree, "x"), "the user's edit\n");
  f.git("add", "x");
  const kept = debugOf(f, "x");
  const { old, next } = commitOnTop(f, { x: null, "x/y": "now below\n" });
  assert.deepEqual(await refreshIndex(f.deps, f.wt, old, next), { refreshed: 0 }, "kills an add that ignores a staying entry above it");
  assert.equal(debugOf(f, "x"), kept);
  assert.equal(entries(f).has("x/y"), false);
});

test("S3: the user's own staged new file at a path the commit adds is kept (kills absent-in-both counted as always equal)", { skip: !posix }, async () => {
  const f = fixture();
  writeFileSync(join(f.wt.workTree, "new.txt"), "the user's new file\n");
  f.git("add", "new.txt");
  const kept = debugOf(f, "new.txt");
  const { old, next } = commitOnTop(f, { "new.txt": "Axis's new file\n" });
  assert.deepEqual(await refreshIndex(f.deps, f.wt, old, next), { refreshed: 0 });
  assert.equal(debugOf(f, "new.txt"), kept);
});

test("S1: an entry racily clean against the index stays marked for a content check after the refresh (kills the copy's new times)", { skip: !posix }, async () => {
  const f = fixture();
  f.git("config", "core.trustctime", "false");
  const r = join(f.wt.workTree, "r.txt");
  const t = Math.floor(Date.now() / 1000) - 60;
  writeFileSync(r, "aaaa\n");
  utimesSync(r, t, t);
  f.git("add", "r.txt");
  writeFileSync(r, "bbbb\n"); // same size, same inode
  utimesSync(r, t, t);
  utimesSync(join(f.wt.gitDir, "index"), t, t); // the entry's mtime equals the index's: racily clean
  const { old, next } = commitOnTop(f, { "a.txt": "axis\n" });
  assert.deepEqual(await refreshIndex(f.deps, f.wt, old, next), { refreshed: 1 });
  assert.ok(f.git("diff", "--name-only").split("\n").includes("r.txt"), "the unstaged same-size edit is still seen");
});
