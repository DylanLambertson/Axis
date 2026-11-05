// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Findings of the independent review, part two: cut lines (S2), the snapshot size cap (S3), file/directory changes (S4)
// and the smaller items.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { ReviewError, ReviewSession, computeOutsideAgent, pathProblem, secretWarnings, type ReviewBinding } from "../src/index.js";
import { escapeWithInfo } from "../src/display.js";
import { acquireIndex } from "../src/tempindex.js";
import { fakeFixture } from "./fake.js";
import { fixture, refusal } from "./fixture.js";

const posix = process.platform !== "win32";
const BASE = Array.from({ length: 20 }, (_, i) => `l${i + 1}\n`).join("");

test("a hunk with a cut line is flagged per line and refuses a per-hunk accept unless acknowledged", async () => {
  const f = fixture();
  try {
    const long = `${"a".repeat(2048)}HIDDEN-PART`;
    f.write("a.txt", BASE.replace("l2\n", `${long}\n`).replace("l18\n", "ends with …\n"));
    const s = await ReviewSession.start(f.deps, { worktree: f.wt, against: f.head() });
    const h = (await s.hunks("a.txt")).hunks ?? [];
    assert.equal(h.length, 2);
    const first = h[0];
    const second = h[1];
    assert.equal(first?.truncated, true);
    const cut = first?.lines.find((l) => l.kind === "+");
    assert.equal(cut?.truncated, true);
    assert.equal(cut?.text, "a".repeat(2048), "the cut text carries no marker character; the flag is the marker");
    assert.equal(second?.truncated, false);
    assert.equal(second?.lines.find((l) => l.kind === "+")?.text, "ends with …", "a real ellipsis is just text");
    assert.equal(second?.lines.find((l) => l.kind === "+")?.truncated, false);

    assert.throws(() => s.acceptHunk("a.txt", first?.id ?? ""), (e: unknown) => e instanceof ReviewError && e.details?.["reason"] === "truncated_hunk");
    s.acceptHunk("a.txt", second?.id ?? "");
    s.acceptHunk("a.txt", first?.id ?? "", { acceptTruncated: true });
    assert.equal(s.decision("a.txt").state, "accepted");
    const p = await s.preview("a.txt", "new");
    assert.equal(p.kind === "text" ? p.truncatedLines : -1, 1);
  } finally {
    f.cleanup();
  }
});

test("escapeWithInfo reports a cut, with or without the ellipsis", () => {
  assert.deepEqual(escapeWithInfo("abcdef", { maxLength: 3 }), { text: "abc…", truncated: true });
  assert.deepEqual(escapeWithInfo("abcdef", { maxLength: 3, ellipsis: false }), { text: "abc", truncated: true });
  assert.deepEqual(escapeWithInfo("abc", { maxLength: 3 }), { text: "abc", truncated: false });
  assert.equal(escapeWithInfo("x".repeat(100), { maxLength: 10, cut: "middle" }).truncated, true);
});

test("a file over the snapshot cap is left out and listed, and is not 'changed outside the agent'", async () => {
  const f = fixture({ deps: { limits: { maxSnapshotFileBytes: 1000 } } });
  try {
    f.write("big.bin", "z".repeat(5000));
    f.write("a.txt", BASE + "z".repeat(5000));
    f.write("small.txt", "ok\n");
    const s = await ReviewSession.start(f.deps, { worktree: f.wt, against: f.head() });
    assert.deepEqual(s.files.map((x) => x.path), ["small.txt"]);
    assert.deepEqual(s.skipped.map((x) => [x.path, x.size, x.reason]).sort(), [["a.txt", BASE.length + 5000, "too_large_to_review"], ["big.bin", 5000, "too_large_to_review"]]);
    assert.equal(s.skippedCount, 2);
    assert.equal(f.git("rev-parse", `${s.worktreeTree}:a.txt`).trim(), f.git("rev-parse", "HEAD:a.txt").trim(), "a tracked file over the cap keeps its base content in the snapshot");

    const head = f.head();
    const report = await computeOutsideAgent(f.deps, { worktree: f.wt, runBase: head, runEnd: f.git("rev-parse", "HEAD^{tree}").trim(), ledger: [], ledgerComplete: true });
    assert.equal(report.outsideCount, 1, "only small.txt differs");
    assert.deepEqual(report.outsideAgent.map((x) => x.path), ["small.txt"]);
  } finally {
    f.cleanup();
  }
});

test("accepting one side of a file and directory change at the same path is refused by name", async () => {
  const f = fixture({ base: ({ write }) => { write("x", "file\n"); write("d/y", "inner\n"); } });
  try {
    rmSync(join(f.repo, "x"));
    f.write("x/y", "dir\n");
    rmSync(join(f.repo, "d"), { recursive: true });
    f.write("d", "now a file\n");
    const s = await ReviewSession.start(f.deps, { worktree: f.wt, against: f.head() });
    assert.deepEqual(s.files.map((x) => `${x.status} ${x.path}`).sort(), ["A d", "A x/y", "D d/y", "D x"]);
    const clash = async (accept: string[]): Promise<ReviewError> => {
      s.reset();
      for (const p of accept) s.acceptFile(p);
      return refusal(s.build());
    };
    for (const only of [["x/y"], ["d"]]) {
      const e = await clash(only);
      assert.equal(e.code, "E_CONFLICT");
      assert.equal(e.details?.["reason"], "path_conflict");
    }
    s.reset();
    for (const p of ["x", "x/y", "d/y", "d"]) s.acceptFile(p);
    const b = await s.build();
    assert.equal(f.git("rev-parse", `${b.reviewedTree}:x/y`).trim(), f.git("rev-parse", `${s.worktreeTree}:x/y`).trim());
    s.reset();
    s.acceptFile("x");
    const removedOnly = await s.build();
    assert.equal(f.git("ls-tree", "-r", "--name-only", removedOnly.reviewedTree).includes("x\n"), false);
  } finally {
    f.cleanup();
  }
});

test("a file name with a colon can be accepted; NTFS and HFS spellings of .git are still refused", { skip: !posix }, async () => {
  const f = fixture();
  try {
    f.write("docs/12:30 notes.md", "hello\n");
    const s = await ReviewSession.start(f.deps, { worktree: f.wt, against: f.head() });
    assert.equal(s.file("docs/12:30 notes.md").unsafePath, false);
    s.acceptFile("docs/12:30 notes.md");
    assert.equal(f.git("ls-tree", "-r", "--name-only", (await s.build()).reviewedTree).includes("docs/12:30 notes.md"), true);
  } finally {
    f.cleanup();
  }
  for (const p of [".git::$INDEX_ALLOCATION/x", ".git:stream", ".g‌it/x", "a/.GIT./x", "GITMOD~1"]) assert.equal(pathProblem(p), "git_dir", p);
  assert.equal(pathProblem("a/b:c/d:e"), undefined);
});

test("secretWarnings refuses an object that is not a binding the package issued", async () => {
  const f = fixture();
  try {
    f.write("a.txt", BASE.replace("l2\n", "L2\n"));
    const s = await ReviewSession.start(f.deps, { worktree: f.wt, against: f.head() });
    s.acceptFile("a.txt");
    const real = await s.build();
    const forged = { ...real } as unknown as ReviewBinding;
    assert.equal((await refusal(secretWarnings(f.deps, forged, s.files))).code, "E_INVALID_ARGUMENT");
    assert.equal((await secretWarnings(f.deps, real, s.files)).scanned, false);
  } finally {
    f.cleanup();
  }
});

test("diff settings in the repository's configuration cannot switch per-hunk review off", async () => {
  const f = fixture({ base: ({ write }) => write("b.txt", Array.from({ length: 12 }, (_, i) => `r${i}\n\n`).join("")) });
  try {
    f.git("config", "diff.suppressBlankEmpty", "true");
    const lines = Array.from({ length: 12 }, (_, i) => `r${i}\n\n`);
    lines[1] = "R1\n\n";
    lines[10] = "R10\n\n";
    f.write("b.txt", lines.join(""));
    const s = await ReviewSession.start(f.deps, { worktree: f.wt, against: f.head() });
    const h = await s.hunks("b.txt");
    assert.equal(h.fileLevelReason, undefined);
    assert.equal(h.hunks?.length, 2);
  } finally {
    f.cleanup();
  }
});

test("a failed object-size call is 'unreadable', never size zero", async () => {
  const fake = fakeFixture([["M", "a.txt"]], { failOn: "-s", patch: "" });
  const s = await ReviewSession.start(fake.deps, { worktree: fake.wt, against: fake.against });
  assert.equal((await s.hunks("a.txt")).fileLevelReason, "unreadable");
});

test("one temporary index file is never shared by two operations at once", async () => {
  let disposed = 0;
  const provider = { create: async () => ({ path: "/tmp/same-index", dispose: async () => { disposed++; } }) };
  const first = await acquireIndex(provider);
  assert.equal((await refusal(acquireIndex(provider))).code, "E_INTERNAL");
  assert.equal(disposed, 0, "the file the first operation is using is left alone");
  await first.release();
  await (await acquireIndex(provider)).release();
  assert.equal(disposed, 2);
});
