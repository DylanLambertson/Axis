// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// OS-6 review 2 F3/F4: the replies the shell's commit notice (shell-core axisCommitDone) is written for. The person staged
// their own version of a path the Axis commit also changed: the refresh keeps it and reports `{ refreshed: 0 }`, so a
// count is no proof the index matches the commit. Another git stages a version after Axis's lock is removed: the reply is
// `{ skipped: 'lock_lost' }` and that staging survives, so a skip is no proof that the committed paths hold old copies
// that a reset could safely replace. In both, the commit's version is not what the index holds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { refreshIndex } from "../src/index.js";
import { commitOnTop, entries, headEntries, indexPath } from "./indexFixture.js";
import { fixture, type Fixture } from "./realFixture.js";

const posix = process.platform !== "win32";
const blob = (f: Fixture, text: string): string => execFileSync("git", ["hash-object", "--stdin"], { cwd: f.wt.workTree, env: f.env, input: text, encoding: "utf8" }).trim();

test("the person's own staging on a committed path: refreshed 0, their version kept, not the commit's", { skip: !posix }, async () => {
  const f = fixture();
  writeFileSync(join(f.wt.workTree, "a.txt"), "own staged\n");
  f.git("add", "a.txt");
  const { old, next } = commitOnTop(f, { "a.txt": "reviewed\n" });
  assert.deepEqual(await refreshIndex(f.deps, f.wt, old, next), { refreshed: 0 });
  assert.equal(entries(f).get("a.txt"), `100644 ${blob(f, "own staged\n")}`);
  assert.notEqual(entries(f).get("a.txt"), headEntries(f).get("a.txt"), "the index does not match the commit on this path");
});

test("another git stages a version after Axis's lock is removed: lock_lost, and that staging survives", { skip: !posix }, async () => {
  const f = fixture();
  const { old, next } = commitOnTop(f, { "a.txt": "reviewed\n" });
  const r = await refreshIndex(f.deps, f.wt, old, next, {
    beforeRename: () => {
      rmSync(`${indexPath(f)}.lock`);
      writeFileSync(join(f.wt.workTree, "a.txt"), "concurrent\n");
      f.git("add", "a.txt");
    },
  });
  assert.deepEqual(r, { skipped: "lock_lost" });
  assert.equal(entries(f).get("a.txt"), `100644 ${blob(f, "concurrent\n")}`, "the other git's staging, neither old HEAD's nor the commit's");
});
