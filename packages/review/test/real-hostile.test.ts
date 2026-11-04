// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// A repository that tries to make review run its code, hide content or exhaust the daemon (FT-1, GIT-ENV-1, DRF).
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ReviewError, ReviewSession, checkFresh, prepareCommit, secretWarnings } from "../src/index.js";
import { fixture, leftoverIndexes, refusal, type Fixture } from "./fixture.js";

const posix = process.platform !== "win32";
const BASE = Array.from({ length: 20 }, (_, i) => `l${i + 1}\n`).join("");

function script(f: Fixture, name: string): { path: string; marker: string } {
  const marker = join(f.root, `${name}.marker`);
  const path = join(f.root, `${name}.sh`);
  writeFileSync(path, `#!/bin/sh\necho ran >> "${marker}"\ncat\n`);
  chmodSync(path, 0o755);
  return { path, marker };
}

test("an external diff driver, a textconv, filters and a hooks path in the repository config run nothing", { skip: !posix }, async () => {
  const f = fixture({ base: ({ write }) => write(".gitattributes", "*.txt diff=evil\n*.dat filter=evil\n") });
  try {
    const ext = script(f, "ext");
    const conv = script(f, "textconv");
    const clean = script(f, "clean");
    const smudge = script(f, "smudge");
    const hook = script(f, "hook");
    mkdirSync(join(f.repo, ".githooks"));
    writeFileSync(join(f.repo, ".githooks", "post-index-change"), `#!/bin/sh\necho ran >> "${hook.marker}"\n`);
    chmodSync(join(f.repo, ".githooks", "post-index-change"), 0o755);
    f.git("config", "diff.external", ext.path);
    f.git("config", "diff.evil.command", ext.path);
    f.git("config", "diff.evil.textconv", conv.path);
    f.git("config", "filter.evil.clean", clean.path);
    f.git("config", "filter.evil.smudge", smudge.path);
    f.git("config", "filter.evil.required", "true");
    f.git("config", "core.hooksPath", ".githooks");

    f.write("a.txt", BASE.replace("l2\n", "L2\n").replace("l18\n", "L18\n"));
    f.write("new.txt", "fresh\n");
    f.write("blob.dat", "payload\n");
    const scanned: string[] = [];
    const deps = { ...f.deps, git: { ...f.gitOps, scanner: async (d: string) => { scanned.push(d); return []; } } };
    const s = await ReviewSession.start(deps, { worktree: f.wt, against: f.head() });
    const h = await s.hunks("a.txt");
    assert.equal(h.hunks?.length, 2, h.fileLevelReason);
    s.acceptHunk("a.txt", h.hunks?.[0]?.id ?? "");
    s.acceptFile("new.txt");
    assert.equal(s.file("blob.dat").kind, "filtered", "a path with a filter attribute is listed, flagged and never offered");
    assert.throws(() => s.acceptFile("blob.dat"), (e: unknown) => e instanceof ReviewError && e.details?.["reason"] === "filtered_path");
    await s.preview("a.txt", "new");
    const b = await s.build();
    await secretWarnings(deps, b, s.files);
    await checkFresh(deps, b);
    await prepareCommit(deps, b);
    assert.match(scanned[0] ?? "", /^diff --git/m);
    for (const m of [ext, conv, clean, smudge, hook]) assert.equal(existsSync(m.marker), false, `${m.path} ran`);

    // Controls: the same configuration does run each program when git is allowed to, so the assertions above are real.
    f.git("diff", "--ext-diff", "HEAD", "--", "a.txt");
    assert.equal(existsSync(ext.marker), true, "control: the external diff driver is live");
    f.git("add", "-A");
    assert.equal(existsSync(clean.marker), true, "control: the clean filter is live");
    f.git("config", "diff.evil.textconv", conv.path);
    f.git("diff", "--no-ext-diff", "--textconv", "HEAD", "--", "a.txt");
    assert.equal(existsSync(conv.marker), true, "control: the textconv is live");
  } finally {
    f.cleanup();
  }
});

test("diff and display settings in the user's configuration do not change what is reviewed", async () => {
  const plain = fixture();
  const noisy = fixture();
  try {
    for (const [k, v] of [
      ["color.ui", "always"], ["color.diff", "always"], ["diff.noprefix", "true"], ["diff.mnemonicPrefix", "true"], ["diff.context", "0"],
      ["diff.algorithm", "histogram"], ["diff.renames", "false"], ["core.quotepath", "false"], ["core.abbrev", "4"], ["diff.interHunkContext", "0"],
      ["diff.indentHeuristic", "false"], ["core.pager", "false"], ["diff.wsErrorHighlight", "all"], ["status.relativePaths", "false"],
    ] as const) noisy.git("config", k, v);
    const edit = BASE.replace("l2\n", "L2\n").replace("l18\n", "L18\n");
    for (const f of [plain, noisy]) {
      f.write("a.txt", edit);
      f.write("with space.txt", "x\n");
    }
    const [a, b] = await Promise.all([plain, noisy].map((f) => ReviewSession.start(f.deps, { worktree: f.wt, against: f.head() })));
    assert.ok(a && b);
    assert.deepEqual(a.files.map((x) => [x.path, x.status, x.additions]), b.files.map((x) => [x.path, x.status, x.additions]));
    const ha = await a.hunks("a.txt");
    const hb = await b.hunks("a.txt");
    assert.deepEqual(ha.hunks, hb.hunks);
    assert.equal(ha.hunks?.length, 2);
    a.acceptFile("a.txt");
    b.acceptFile("a.txt");
    assert.equal((await a.build()).reviewedTree, (await b.build()).reviewedTree, "same tree in both configurations");
  } finally {
    plain.cleanup();
    noisy.cleanup();
  }
});

test("a giant diff is bounded: whole-file decisions only, nothing truncated is offered as hunks", async () => {
  const lines = (tag: string): string => Array.from({ length: 5000 }, (_, i) => `${tag} ${i}\n`).join("");
  const f = fixture({ base: ({ write }) => write("giant.txt", lines("old")), deps: { limits: { maxPatchBytes: 20_000 } } });
  try {
    f.write("giant.txt", lines("new"));
    const s = await ReviewSession.start(f.deps, { worktree: f.wt, against: f.head() });
    const h = await s.hunks("giant.txt");
    assert.equal(h.hunks, undefined);
    assert.equal(h.fileLevelReason, "patch_too_large");
    s.acceptFile("giant.txt");
    assert.equal((await s.build()).reviewedTree, s.worktreeTree);
  } finally {
    f.cleanup();
  }
});

test("the size limits turn a file whole-file only, in the list and when its hunks are loaded", async () => {
  const f = fixture({
    base: ({ write }) => write("big.txt", "x".repeat(3000) + "\n"),
    deps: { limits: { maxPreviewBytes: 4000, maxHunkFileBytes: 2000, maxHunksPerFile: 2 } },
  });
  try {
    f.write("big.txt", "y".repeat(3000) + "\n");
    f.write("a.txt", BASE.replace("l2\n", "L2\n").replace("l10\n", "L10\n").replace("l18\n", "L18\n"));
    f.write("huge.txt", "z".repeat(5000));
    const s = await ReviewSession.start(f.deps, { worktree: f.wt, against: f.head() });
    assert.equal(s.file("huge.txt").kind, "too-large");
    assert.equal((await s.hunks("big.txt")).fileLevelReason, "too_large");
    assert.equal((await s.hunks("a.txt")).fileLevelReason, "too_many_hunks");
    assert.equal((await s.preview("huge.txt", "new")).kind, "too-large");
  } finally {
    f.cleanup();
  }
});

test("opening more diffs than the cache allows is refused with the bound intact", async () => {
  const f = fixture({ deps: { limits: { maxCachedPatchBytes: 1500 } } });
  try {
    for (let i = 0; i < 10; i++) f.write(`f${i}.txt`, "base\n".repeat(30));
    f.git("add", "-A");
    f.git("commit", "-q", "-m", "files");
    for (let i = 0; i < 10; i++) f.write(`f${i}.txt`, "base\n".repeat(30).replace("base", `CHANGED${i}`));
    const s = await ReviewSession.start(f.deps, { worktree: f.wt, against: f.head() });
    let opened = 0;
    let refused = false;
    for (let i = 0; i < 10 && !refused; i++) {
      try {
        await s.hunks(`f${i}.txt`);
        opened++;
      } catch (e) {
        assert.equal((e as { code?: string }).code, "E_INVALID_ARGUMENT");
        refused = true;
      }
    }
    assert.ok(refused && opened >= 1 && opened < 10, `opened ${opened}`);
    const earlier = await s.hunks("f0.txt");
    assert.ok(earlier.hunks, "what was already open stays usable");
  } finally {
    f.cleanup();
  }
});

test("thousands of changed files are listed and accepted without a per-file process", async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 2500; i++) f.write(`many/f${i}.txt`, `${i}\n`);
    const before = f.seen.length;
    const s = await ReviewSession.start(f.deps, { worktree: f.wt, against: f.head() });
    assert.equal(s.files.length, 2500);
    assert.ok(f.seen.length - before < 20, `${f.seen.length - before} git calls for the list`);
    for (const x of s.files) s.acceptFile(x.path);
    assert.equal((await s.build()).reviewedTree, s.worktreeTree);
  } finally {
    f.cleanup();
  }
});

test("a temporary index that cannot be removed does not hide the result, and a failing git call still releases it", async () => {
  const f = fixture();
  try {
    let disposed = 0;
    const deps = {
      ...f.deps,
      tempIndex: {
        create: async () => ({ path: join(f.root, `idx-${disposed}`), dispose: async () => { disposed++; throw new Error("disk says no"); } }),
      },
    };
    f.write("a.txt", BASE.replace("l2\n", "L2\n"));
    const s = await ReviewSession.start(deps, { worktree: f.wt, against: f.head() });
    assert.equal(s.files.length, 1);
    assert.equal(disposed, 1);
    s.acceptFile("a.txt");
    await s.build();
    assert.equal(disposed, 2);
    assert.deepEqual(leftoverIndexes(f), []);
  } finally {
    f.cleanup();
  }
});

test("a temporary index path that is relative or contains NUL is refused before git runs", async () => {
  const f = fixture();
  try {
    for (const path of ["relative/index", "a\0b"]) {
      const deps = { ...f.deps, tempIndex: { create: async () => ({ path, dispose: async () => undefined }) } };
      assert.equal((await refusal(ReviewSession.start(deps, { worktree: f.wt, against: f.head() }))).code, "E_INVALID_ARGUMENT");
    }
  } finally {
    f.cleanup();
  }
});
