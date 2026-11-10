// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The changed-files list against a real repository: every status and kind (design §3).
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ReviewSession } from "../src/index.js";
import { fixture, leftoverIndexes, refusal } from "./fixture.js";

const posix = process.platform !== "win32";
const LONG = Array.from({ length: 40 }, (_, i) => `line number ${i} of a file long enough for rename detection\n`).join("");

function everyKind(): ReturnType<typeof fixture> {
  return fixture({
    base: ({ repo, git, write }) => {
      write("del.txt", "to be deleted\n");
      write("ren.txt", LONG);
      write("exec.sh", "#!/bin/sh\necho hi\n");
      write("bin.dat", Buffer.from([1, 2, 0, 3, 4, 0, 5]));
      write("typechg", "was a file\n");
      symlinkSync("a.txt", join(repo, "link"));
      mkdirSync(join(repo, "sub"));
      git("-C", join(repo, "sub"), "init", "-q", "-b", "main");
      git("-C", join(repo, "sub"), "config", "user.name", "x");
      git("-C", join(repo, "sub"), "config", "user.email", "x@example.com");
      writeFileSync(join(repo, "sub", "f"), "1\n");
      git("-C", join(repo, "sub"), "add", "-A");
      git("-C", join(repo, "sub"), "commit", "-q", "-m", "one");
    },
  });
}

test("every status and kind is listed, with the right classification", { skip: !posix }, async () => {
  const f = everyKind();
  try {
    f.write("a.txt", f.git("show", "HEAD:a.txt").replace("l2\n", "L2\n"));
    unlinkSync(join(f.repo, "del.txt"));
    f.write("new.txt", "brand new\n");
    unlinkSync(join(f.repo, "ren.txt"));
    f.write("renamed.txt", LONG.replace("number 3 ", "number THREE "));
    chmodSync(join(f.repo, "exec.sh"), 0o755);
    f.write("bin.dat", Buffer.from([9, 9, 0, 9]));
    unlinkSync(join(f.repo, "link"));
    symlinkSync("/etc/passwd", join(f.repo, "link"));
    unlinkSync(join(f.repo, "typechg"));
    symlinkSync("a.txt", join(f.repo, "typechg"));
    writeFileSync(join(f.repo, "sub", "f"), "2\n");
    f.git("-C", join(f.repo, "sub"), "commit", "-q", "-a", "-m", "two");
    f.write('we"ird\nname.txt', "x\n");

    const s = await ReviewSession.start(f.deps, { worktree: f.wt, against: f.head() });
    const by = new Map(s.files.map((x) => [x.path, x]));
    const get = (p: string) => by.get(p) ?? assert.fail(`missing ${p}`);
    assert.equal(get("a.txt").status, "M");
    assert.equal(get("a.txt").kind, "text");
    assert.equal(get("a.txt").fileLevelReason, undefined);
    assert.equal(get("del.txt").status, "D");
    assert.equal(get("new.txt").status, "A");
    const r = get("renamed.txt");
    assert.equal(r.status, "R");
    assert.equal(r.oldPath, "ren.txt");
    assert.ok((r.similarity ?? 0) >= 50 && (r.similarity ?? 100) < 100);
    assert.equal(r.fileLevelReason, undefined, "a renamed text file with edits has hunks");
    assert.equal(by.has("ren.txt"), false, "the old side of a rename is not a separate entry");
    assert.equal(get("exec.sh").status, "M");
    assert.equal(get("exec.sh").newMode, "100755");
    assert.equal(get("exec.sh").fileLevelReason, "no_content_change");
    assert.equal(get("bin.dat").kind, "binary");
    assert.equal(get("bin.dat").fileLevelReason, "binary");
    const link = get("link");
    assert.equal(link.kind, "symlink");
    assert.equal(link.link?.escapesWorktree, true);
    assert.ok(link.warnings.includes("symlink-outside"));
    assert.equal(link.link?.target, "/etc/passwd");
    assert.equal(get("typechg").status, "T");
    assert.equal(get("typechg").fileLevelReason, "type_change");
    assert.equal(get("typechg").link?.escapesWorktree, false);
    const sub = get("sub");
    assert.equal(sub.kind, "submodule");
    assert.equal(sub.newMode, "160000");
    assert.ok(sub.warnings.includes("submodule"));
    const weird = [...by.values()].find((x) => x.path.startsWith("we"));
    assert.ok(weird);
    assert.equal(weird.path, 'we"ird\nname.txt');
    assert.equal(weird.displayPath, 'we"ird\\nname.txt');
    assert.equal(weird.unsafePath, false);
    assert.deepEqual(leftoverIndexes(f), [], "every temporary index was removed");
    assert.equal(f.indexes.created, f.indexes.disposed);
  } finally {
    f.cleanup();
  }
});

test("a path that git would ignore or that leaves the tree is listed as unsafe and cannot be accepted", async () => {
  // Hostile names cannot be written to a real worktree, so the list is produced by a runner that reports them.
  const { fakeFixture } = await import("./fake.js");
  const f = fakeFixture([
    ["M", "ok.txt"], ["M", "../../etc/cron.d/x"], ["A", ".git/hooks/pre-commit"], ["A", "/abs/path"], ["A", "a\\..\\b"],
  ]);
  const s = await ReviewSession.start(f.deps, { worktree: f.wt, against: f.against });
  const unsafe = s.files.filter((x) => x.unsafePath).map((x) => x.path);
  assert.deepEqual(unsafe, ["../../etc/cron.d/x", ".git/hooks/pre-commit", "/abs/path", "a\\..\\b"]);
  for (const p of unsafe) {
    assert.throws(() => s.acceptFile(p), (e: Error & { code?: string }) => e.code === "E_POLICY_DENIED");
    assert.equal(s.file(p).fileLevelReason, "unsafe_path");
  }
  s.acceptFile("ok.txt");
});

test("more changed files than the limit makes the review refuse instead of listing part of them", async () => {
  const f = fixture({ deps: { limits: { maxFiles: 3 } } });
  try {
    for (let i = 0; i < 4; i++) f.write(`n${i}.txt`, `${i}\n`);
    const e = await refusal(ReviewSession.start(f.deps, { worktree: f.wt, against: f.head() }));
    assert.equal(e.code, "E_INVALID_ARGUMENT");
    assert.equal(e.details?.["reason"], "too_large");
    assert.deepEqual(leftoverIndexes(f), []);
  } finally {
    f.cleanup();
  }
});

test("a matcher flags both sides of a rename, a throwing matcher fails closed, and nothing else is flagged", async () => {
  const f = fixture({
    base: ({ write }) => write(".github/workflows/ci.yml", LONG),
    deps: {
      protectedPaths: {
        match: (p) => {
          if (p === "boom.txt") throw new Error("matcher bug");
          return p.startsWith(".github/workflows/") ? [{ rule: "ci-workflow" }] : [];
        },
      },
    },
  });
  try {
    f.write("keep.txt", "changed\n");
    f.write("boom.txt", "x\n");
    mkdirSync(join(f.repo, "docs"));
    rmSync(join(f.repo, ".github"), { recursive: true });
    f.write("docs/ci.yml", LONG.replace("number 1 ", "number ONE "));
    const s = await ReviewSession.start(f.deps, { worktree: f.wt, against: f.head() });
    const by = new Map(s.files.map((x) => [x.path, x]));
    assert.deepEqual(by.get("docs/ci.yml")?.protectedRules, ["ci-workflow"], "moving a workflow out is flagged through its old path");
    assert.equal(by.get("docs/ci.yml")?.status, "R");
    assert.deepEqual(by.get("boom.txt")?.protectedRules, ["matcher-error"]);
    assert.deepEqual(by.get("keep.txt")?.protectedRules, []);
  } finally {
    f.cleanup();
  }
});

test("reviewing against a commit that is not a commit, not found or malformed is refused", async () => {
  const f = fixture();
  try {
    const tree = f.git("rev-parse", "HEAD^{tree}").trim();
    assert.equal((await refusal(ReviewSession.start(f.deps, { worktree: f.wt, against: tree }))).code, "E_INVALID_ARGUMENT");
    assert.equal((await refusal(ReviewSession.start(f.deps, { worktree: f.wt, against: "0".repeat(40) }))).code, "E_INVALID_ARGUMENT");
    assert.equal((await refusal(ReviewSession.start(f.deps, { worktree: f.wt, against: "--upload-pack=x" }))).code, "E_INVALID_ARGUMENT");
    assert.equal((await refusal(ReviewSession.start(f.deps, { worktree: f.wt, against: "HEAD" }))).code, "E_INVALID_ARGUMENT");
    const bad = { workTree: "relative/path", gitDir: f.wt.gitDir };
    assert.equal((await refusal(ReviewSession.start(f.deps, { worktree: bad, against: f.head() }))).code, "E_INVALID_ARGUMENT");
  } finally {
    f.cleanup();
  }
});

test("nothing leaks: ignored files stay out of the review, and a clean worktree has no changes", async () => {
  const f = fixture({ base: ({ write }) => write(".gitignore", "*.log\n") });
  try {
    f.write("debug.log", "noise\n");
    const s = await ReviewSession.start(f.deps, { worktree: f.wt, against: f.head() });
    assert.deepEqual(s.files, []);
    assert.equal(s.worktreeTree, f.git("rev-parse", "HEAD^{tree}").trim());
  } finally {
    f.cleanup();
  }
});

const underGithub = { match: (p: string) => (p.startsWith(".github/") ? [{ rule: "ci-workflow" }] : []) };

test("a rename into a protected path is flagged through its new path", { skip: !posix }, async () => {
  const f = fixture({ base: ({ write }) => write("docs/ci.yml", LONG), deps: { protectedPaths: underGithub } });
  try {
    rmSync(join(f.repo, "docs"), { recursive: true });
    f.write(".github/workflows/ci.yml", LONG.replace("number 1 ", "number ONE "));
    const s = await ReviewSession.start(f.deps, { worktree: f.wt, against: f.head() });
    const moved = s.files.find((x) => x.path === ".github/workflows/ci.yml");
    assert.equal(moved?.status, "R");
    assert.deepEqual(moved?.protectedRules, ["ci-workflow"]);
  } finally {
    f.cleanup();
  }
});

test("a symlink at an ordinary path is flagged when its target is protected; an outside or ordinary target is not", { skip: !posix }, async () => {
  const f = fixture({ base: ({ write }) => write(".github/workflows/ci.yml", LONG), deps: { protectedPaths: underGithub } });
  try {
    mkdirSync(join(f.repo, "docs"));
    symlinkSync("../.github/workflows/ci.yml", join(f.repo, "docs", "to-ci"));
    symlinkSync("./../.github//workflows/./ci.yml", join(f.repo, "docs", "messy"));
    symlinkSync("a.txt", join(f.repo, "plain"));
    symlinkSync("../../.github/workflows/ci.yml", join(f.repo, "docs", "escapes"));
    const s = await ReviewSession.start(f.deps, { worktree: f.wt, against: f.head() });
    const rules = (p: string): readonly string[] | undefined => s.files.find((x) => x.path === p)?.protectedRules;
    assert.deepEqual(rules("docs/to-ci"), ["ci-workflow"]);
    assert.deepEqual(rules("docs/messy"), ["ci-workflow"]);
    assert.deepEqual(rules("plain"), []);
    assert.deepEqual(rules("docs/escapes"), [], "a target above the repository root is the symlink-outside warning, not a rule");
    assert.ok(s.files.find((x) => x.path === "docs/escapes")?.warnings.includes("symlink-outside"));
  } finally {
    f.cleanup();
  }
});
