// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Accept and reject per file and per hunk, and the reviewed tree they produce (design §4, §5).
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ReviewSession } from "../src/index.js";
import { fixture, leftoverIndexes, refusal, type Fixture } from "./fixture.js";

const posix = process.platform !== "win32";
const LONG = Array.from({ length: 40 }, (_, i) => `line number ${i} of a file long enough for rename detection\n`).join("");
const TEN = Array.from({ length: 20 }, (_, i) => `l${i + 1}\n`).join("");

async function start(f: Fixture): Promise<ReviewSession> {
  return ReviewSession.start(f.deps, { worktree: f.wt, against: f.head() });
}
const idOf = async (s: ReviewSession, path: string, n: number): Promise<string> => {
  const h = await s.hunks(path);
  return h.hunks?.[n]?.id ?? assert.fail("no such hunk");
};
const show = (f: Fixture, tree: string, path: string): string => f.git("cat-file", "blob", `${tree}:${path}`);

test("accepting one of two hunks puts only that hunk in the reviewed tree and touches nothing of the user's", async () => {
  const f = fixture();
  try {
    const edited = TEN.replace("l2\n", "L2\n").replace("l18\n", "L18\n");
    f.write("a.txt", edited);
    const before = { index: f.git("write-tree").trim(), status: f.git("status", "--porcelain"), head: f.head() };
    const s = await start(f);
    const h = await s.hunks("a.txt");
    assert.equal(h.hunks?.length, 2);
    s.acceptHunk("a.txt", await idOf(s, "a.txt", 0));
    assert.deepEqual(s.decision("a.txt").state, "partial");
    const b = await s.build();
    assert.equal(show(f, b.reviewedTree, "a.txt"), TEN.replace("l2\n", "L2\n"));
    assert.equal(b.worktreeTree, s.worktreeTree);
    assert.equal(b.headTree, f.git("rev-parse", "HEAD^{tree}").trim());
    assert.equal(readFileSync(join(f.repo, "a.txt"), "utf8"), edited, "the worktree file is untouched");
    assert.deepEqual({ index: f.git("write-tree").trim(), status: f.git("status", "--porcelain"), head: f.head() }, before, "index, status and HEAD are unchanged");
    assert.deepEqual(leftoverIndexes(f), []);
    assert.equal(b.accepted[0]?.partial, true);
    assert.deepEqual(b.accepted[0]?.hunks, [0]);
  } finally {
    f.cleanup();
  }
});

test("accepting the second hunk only, then rejecting it, gives the base back (and nothing accepted is refused)", async () => {
  const f = fixture();
  try {
    f.write("a.txt", TEN.replace("l2\n", "L2\n").replace("l18\n", "L18\n"));
    const s = await start(f);
    const second = await idOf(s, "a.txt", 1);
    s.acceptHunk("a.txt", second);
    assert.equal(show(f, (await s.build()).reviewedTree, "a.txt"), TEN.replace("l18\n", "L18\n"));
    s.rejectHunk("a.txt", second);
    assert.equal(s.decision("a.txt").state, "none");
    assert.equal((await refusal(s.build())).code, "E_POLICY_DENIED");
  } finally {
    f.cleanup();
  }
});

test("accepting every hunk is the whole file, and a whole file rejected hunk by hunk becomes partial", async () => {
  const f = fixture();
  try {
    f.write("a.txt", TEN.replace("l2\n", "L2\n").replace("l18\n", "L18\n"));
    const s = await start(f);
    s.acceptHunk("a.txt", await idOf(s, "a.txt", 0));
    s.acceptHunk("a.txt", await idOf(s, "a.txt", 1));
    assert.equal(s.decision("a.txt").state, "accepted");
    assert.equal((await s.build()).reviewedTree, s.worktreeTree, "everything accepted is the worktree tree");
    s.rejectHunk("a.txt", await idOf(s, "a.txt", 0));
    assert.equal(s.decision("a.txt").state, "partial");
    assert.equal(show(f, (await s.build()).reviewedTree, "a.txt"), TEN.replace("l18\n", "L18\n"));
    s.acceptFile("a.txt");
    s.rejectFile("a.txt");
    assert.equal(s.decision("a.txt").state, "none");
  } finally {
    f.cleanup();
  }
});

test("accepting every change of every kind reproduces the worktree tree exactly", { skip: !posix }, async () => {
  const f = fixture({
    base: ({ repo, write }) => {
      write("del.txt", "gone\n");
      write("ren.txt", LONG);
      write("exec.sh", "#!/bin/sh\n");
      write("bin.dat", Buffer.from([1, 0, 2]));
      write("typechg", "file\n");
      symlinkSync("a.txt", join(repo, "link"));
    },
  });
  try {
    f.write("a.txt", TEN.replace("l2\n", "L2\n"));
    unlinkSync(join(f.repo, "del.txt"));
    f.write("new.txt", "new\n");
    f.write("sub/dir/deep.txt", "deep\n");
    unlinkSync(join(f.repo, "ren.txt"));
    f.write("moved/ren.txt", LONG.replace("number 5 ", "number FIVE "));
    chmodSync(join(f.repo, "exec.sh"), 0o755);
    f.write("bin.dat", Buffer.from([7, 0, 7, 0]));
    unlinkSync(join(f.repo, "link"));
    symlinkSync("../outside", join(f.repo, "link"));
    unlinkSync(join(f.repo, "typechg"));
    symlinkSync("a.txt", join(f.repo, "typechg"));
    f.write('q"uote\nnl.txt', "q\n");
    const s = await start(f);
    for (const x of s.files) s.acceptFile(x.path);
    const b = await s.build();
    assert.equal(b.reviewedTree, s.worktreeTree);
    assert.equal(b.accepted.length, s.files.length);
  } finally {
    f.cleanup();
  }
});

test("accepting some files leaves exactly those changes in the reviewed tree", { skip: !posix }, async () => {
  const f = fixture({ base: ({ write }) => { write("del.txt", "gone\n"); write("ren.txt", LONG); } });
  try {
    f.write("a.txt", TEN.replace("l2\n", "L2\n"));
    f.write("keep.txt", "changed\n");
    unlinkSync(join(f.repo, "del.txt"));
    f.write("new.txt", "new\n");
    unlinkSync(join(f.repo, "ren.txt"));
    f.write("ren2.txt", LONG.replace("number 5 ", "number FIVE "));
    const s = await start(f);
    s.acceptFile("del.txt");
    s.acceptFile("new.txt");
    s.acceptFile("ren2.txt");
    const b = await s.build();
    const changes = f.git("diff-tree", "-r", "--no-renames", "--name-status", b.headTree, b.reviewedTree).trim().split("\n").sort();
    assert.deepEqual(changes, ["A\tnew.txt", "A\tren2.txt", "D\tdel.txt", "D\tren.txt"]);
    assert.equal(show(f, b.reviewedTree, "a.txt"), TEN, "an unaccepted edit is not in the tree");
  } finally {
    f.cleanup();
  }
});

test("a rename accepted by hunk keeps the old path out, the new path partially edited", async () => {
  const f = fixture({ base: ({ write }) => write("ren.txt", LONG) });
  try {
    unlinkSync(join(f.repo, "ren.txt"));
    const edited = LONG.replace("number 2 ", "number TWO ").replace("number 35 ", "number T35 ");
    f.write("renamed.txt", edited);
    const s = await start(f);
    const file = s.files[0];
    assert.equal(file?.status, "R");
    const hunks = await s.hunks("renamed.txt");
    assert.equal(hunks.hunks?.length, 2);
    s.acceptHunk("renamed.txt", await idOf(s, "renamed.txt", 1));
    const b = await s.build();
    assert.equal(show(f, b.reviewedTree, "renamed.txt"), LONG.replace("number 35 ", "number T35 "));
    assert.throws(() => f.git("cat-file", "-e", `${b.reviewedTree}:ren.txt`), "the old path is gone");
  } finally {
    f.cleanup();
  }
});

test("CRLF lines, other line separators and a missing final newline survive a partial accept byte for byte", async () => {
  const base = "a\r\nb\r\nc\r\nd\r\ne\r\nf\r\ng\r\nh\r\ni\r\nj k\r\nl";
  const f = fixture({ base: ({ write }) => write("w.txt", base) });
  try {
    const edited = base.replace("b\r\n", "B\r\n").replace("l", "l\r\nm");
    f.write("w.txt", edited);
    const s = await start(f);
    const h = await s.hunks("w.txt");
    assert.equal(h.hunks?.length, 2, h.fileLevelReason);
    assert.equal(h.hunks?.[0]?.lines.find((l) => l.kind === "+")?.eol, "crlf");
    s.acceptHunk("w.txt", await idOf(s, "w.txt", 0));
    assert.equal(show(f, (await s.build()).reviewedTree, "w.txt"), base.replace("b\r\n", "B\r\n"));
    s.rejectHunk("w.txt", await idOf(s, "w.txt", 0));
    s.acceptHunk("w.txt", await idOf(s, "w.txt", 1));
    assert.equal(show(f, (await s.build()).reviewedTree, "w.txt"), base.replace("l", "l\r\nm"));
  } finally {
    f.cleanup();
  }
});

test("a file that git treats as binary through an attribute is whole-file only, with a placeholder preview", async () => {
  const f = fixture({ base: ({ write }) => { write(".gitattributes", "*.dat -diff\n"); write("t.dat", "text\n"); } });
  try {
    f.write("t.dat", "changed text\n");
    const s = await start(f);
    const file = s.files.find((x) => x.path === "t.dat");
    assert.equal(file?.kind, "binary");
    assert.equal((await s.hunks("t.dat")).fileLevelReason, "binary");
    assert.throws(() => s.acceptHunk("t.dat", "0:abc"), (e: Error & { code?: string }) => e.code === "E_INVALID_ARGUMENT");
    s.acceptFile("t.dat");
    assert.equal(show(f, (await s.build()).reviewedTree, "t.dat"), "changed text\n");
  } finally {
    f.cleanup();
  }
});

test("hunk names and states are checked", async () => {
  const f = fixture();
  try {
    f.write("a.txt", TEN.replace("l2\n", "L2\n"));
    f.write("keep.txt", "k2\n");
    const s = await start(f);
    assert.throws(() => s.acceptHunk("a.txt", "0:0000000000000000"), (e: Error & { code?: string }) => e.code === "E_INVALID_ARGUMENT", "hunks are not loaded yet");
    await s.hunks("a.txt");
    assert.throws(() => s.acceptHunk("a.txt", "0:0000000000000000"), (e: Error & { code?: string }) => e.code === "E_NOT_FOUND");
    assert.throws(() => s.acceptFile("missing.txt"), (e: Error & { code?: string }) => e.code === "E_NOT_FOUND");
    assert.throws(() => s.decision("../x"), (e: Error & { code?: string }) => e.code === "E_NOT_FOUND");
    assert.deepEqual(s.decision("keep.txt"), { state: "none", hunks: [] });
  } finally {
    f.cleanup();
  }
});

test("a review against an older commit is for looking: it cannot build a binding", async () => {
  const f = fixture();
  try {
    const old = f.head();
    f.write("n.txt", "n\n");
    f.git("add", "-A");
    f.git("commit", "-q", "-m", "second");
    f.write("keep.txt", "later\n");
    const s = await ReviewSession.start(f.deps, { worktree: f.wt, against: old });
    assert.deepEqual(s.files.map((x) => x.path), ["keep.txt", "n.txt"]);
    s.acceptFile("keep.txt");
    const e = await refusal(s.build());
    assert.equal(e.code, "E_CONFLICT");
    assert.equal(e.details?.["reason"], "not_head");
  } finally {
    f.cleanup();
  }
});

test("a decision made while the tree is being built does not change that build", async () => {
  const f = fixture();
  try {
    f.write("a.txt", TEN.replace("l2\n", "L2\n"));
    f.write("keep.txt", "k2\n");
    const s = await start(f);
    s.acceptFile("a.txt");
    const pending = s.build();
    s.acceptFile("keep.txt");
    const b = await pending;
    assert.deepEqual(b.accepted.map((a) => a.path), ["a.txt"]);
  } finally {
    f.cleanup();
  }
});

test("a binding cannot be forged and is immutable", async () => {
  const f = fixture();
  try {
    f.write("a.txt", TEN.replace("l2\n", "L2\n"));
    const s = await start(f);
    s.acceptFile("a.txt");
    const b = await s.build();
    assert.ok(Object.isFrozen(b) && Object.isFrozen(b.accepted) && Object.isFrozen(b.worktree));
    assert.throws(() => { (b as { reviewedTree: string }).reviewedTree = "0".repeat(40); }, TypeError);
    assert.match(b.digest, /^[0-9a-f]{64}$/);
    const Ctor = b.constructor as new (token: symbol, init: object) => unknown;
    assert.throws(() => new Ctor(Symbol("x"), {}), (e: Error & { code?: string }) => e.code === "E_INVALID_ARGUMENT");
  } finally {
    f.cleanup();
  }
});

test("writing a file as part of the review never touches the worktree files", async () => {
  const f = fixture();
  try {
    f.write("a.txt", TEN.replace("l2\n", "L2\n"));
    writeFileSync(join(f.repo, "untracked.txt"), "u\n");
    const s = await start(f);
    s.acceptFile("untracked.txt");
    await s.build();
    assert.equal(readFileSync(join(f.repo, "a.txt"), "utf8"), TEN.replace("l2\n", "L2\n"));
    assert.equal(f.git("status", "--porcelain").includes("?? untracked.txt"), true, "still untracked and unstaged");
  } finally {
    f.cleanup();
  }
});
