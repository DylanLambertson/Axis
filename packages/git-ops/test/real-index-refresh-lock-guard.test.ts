// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// DC-0b review 1 B1(a), a data-loss bug of DC-0 slice 2: the user removes `.git/index.lock` while the refresh holds it (git's
// own message tells them to). The refresh must then do nothing: never let git read a missing lock as an EMPTY index, never
// rename anything that is not the very lock it created over `.git/index`, and never remove a lock that is not its own.
// Mutants: no identity check before the edit, none before the rename, no empty-copy guard, a cleanup that removes a lock
// another git made.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { refreshIndex } from "../src/index.js";
import { commitOnTop, entries, indexBytes, indexPath } from "./indexFixture.js";
import { fixture, stage, type Fixture } from "./realFixture.js";

const posix = process.platform !== "win32";
const lockOf = (f: Fixture): string => `${indexPath(f)}.lock`;

/** A repository whose index holds several entries, and a commit on top that adds b.txt. */
function setup(): { f: Fixture; old: string; next: string } {
  const f = fixture();
  for (const n of [1, 2, 3]) stage(f, `c${n}.txt`, `${n}\n`);
  f.git("commit", "-q", "-m", "three more");
  const { old, next } = commitOnTop(f, { "b.txt": "b\n" });
  return { f, old, next };
}

for (const at of ["beforeUpdate", "beforeRename"] as const) {
  test(`${at}: the user removes index.lock: lock_lost, the index byte-identical, nothing left behind (kills no identity check ${at === "beforeUpdate" ? "before the edit" : "before the rename"})`, { skip: !posix }, async () => {
    const { f, old, next } = setup();
    const before = indexBytes(f);
    const r = await refreshIndex(f.deps, f.wt, old, next, { [at]: () => rmSync(lockOf(f)) });
    assert.deepEqual(r, { skipped: "lock_lost" });
    assert.deepEqual(indexBytes(f), before);
    assert.deepEqual([...entries(f).keys()].sort(), ["a.txt", "c1.txt", "c2.txt", "c3.txt"], "no file became a staged deletion");
    assert.equal(existsSync(lockOf(f)), false, "the refresh made no new lock");
  });

  test(`${at}: the user removes index.lock and another git takes it: that lock is kept, the index untouched (kills a cleanup of a lock not ours)`, { skip: !posix }, async () => {
    const { f, old, next } = setup();
    const before = indexBytes(f);
    const r = await refreshIndex(f.deps, f.wt, old, next, {
      [at]: () => {
        rmSync(lockOf(f));
        writeFileSync(lockOf(f), "another git's lock\n");
      },
    });
    assert.deepEqual(r, { skipped: "lock_lost" });
    assert.deepEqual(indexBytes(f), before);
    assert.equal(readFileSync(lockOf(f), "utf8"), "another git's lock\n");
  });
}

test("a private copy that reads as empty although the index has entries is refused (kills no empty-copy guard)", { skip: !posix }, async () => {
  const { f, old, next } = setup();
  const before = indexBytes(f);
  const r = await refreshIndex(f.deps, f.wt, old, next, {
    afterCopy: (copy) => void execFileSync("git", ["read-tree", "--empty"], { cwd: f.wt.workTree, env: { ...f.env, GIT_INDEX_FILE: copy } }),
  });
  assert.deepEqual(r, { skipped: "unreadable" });
  assert.deepEqual(indexBytes(f), before);
  assert.equal(existsSync(lockOf(f)), false, "Axis's own lock is removed");
});
