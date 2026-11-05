// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Findings of the second independent review: filter detection that cannot be bypassed through the attribute files (SF-1),
// the cut-line acknowledgement on every accept path (SF-2), and the tests the first fix round lacked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ReviewError, ReviewSession, prepareCommit } from "../src/index.js";
import { fixture, refusal, type Fixture } from "./fixture.js";
import { PASS, REVERSE, withFilter } from "./filters.js";

const posix = process.platform !== "win32";
const BASE = Array.from({ length: 20 }, (_, i) => `l${i + 1}\n`).join("");
const ATTR = "*.dat filter=vault\n";

function filtered(clean = REVERSE, extra?: (a: Parameters<ReturnType<typeof withFilter>>[0]) => void): Fixture {
  return fixture({ base: (a) => { withFilter(clean, PASS)(a); extra?.(a); } });
}

async function assertNotOffered(f: Fixture, path: string): Promise<void> {
  const s = await ReviewSession.start(f.deps, { worktree: f.wt, against: f.head() });
  assert.equal(s.file(path).kind, "filtered", `${path} is listed as filtered`);
  assert.throws(() => s.acceptFile(path), (e: unknown) => e instanceof ReviewError && e.details?.["reason"] === "filtered_path");
}

const BYPASSES: readonly (readonly [string, (f: Fixture) => void])[] = [
  ["a staged edit of .gitattributes", (f) => { f.write(".gitattributes", "# nothing\n"); f.git("add", ".gitattributes"); }],
  ["git rm of .gitattributes", (f) => { f.git("rm", "-q", ".gitattributes"); }],
  ["-filter in .git/info/attributes", (f) => { mkdirSync(join(f.repo, ".git", "info"), { recursive: true }); writeFileSync(join(f.repo, ".git", "info", "attributes"), "vault.dat -filter\n"); }],
  ["a worktree-only edit of .gitattributes", (f) => { f.write(".gitattributes", "# nothing\n"); }],
];
for (const [name, bypass] of BYPASSES) {
  test(`filtered-ness comes from the base too: ${name} does not make a stored blob look plain`, { skip: !posix }, async () => {
    const f = filtered();
    try {
      bypass(f);
      await assertNotOffered(f, "vault.dat");
    } finally {
      f.cleanup();
    }
  });
}

test("a filter introduced in the worktree's attribute file only is seen (the worktree read)", { skip: !posix }, async () => {
  const f = filtered(REVERSE, ({ write }) => write("plain.txt", "plain\n"));
  try {
    f.write(".gitattributes", `${ATTR}plain.txt filter=vault\n`);
    f.write("plain.txt", "edited\n");
    await assertNotOffered(f, "plain.txt");
  } finally {
    f.cleanup();
  }
});

test("a filter introduced in the index's attribute file only is seen (the index read)", { skip: !posix }, async () => {
  const f = filtered(REVERSE, ({ write }) => write("plain.txt", "plain\n"));
  try {
    f.write(".gitattributes", `${ATTR}plain.txt filter=vault\n`);
    f.git("add", ".gitattributes");
    f.write(".gitattributes", ATTR);
    f.write("plain.txt", "edited\n");
    await assertNotOffered(f, "plain.txt");
  } finally {
    f.cleanup();
  }
});

test("a rename out of a filtered path is filtered through its old path", { skip: !posix }, async () => {
  const f = filtered(PASS);
  try {
    rmSync(join(f.repo, "vault.dat"));
    f.write("vault.txt", "hello world\n");
    const s = await ReviewSession.start(f.deps, { worktree: f.wt, against: f.head() });
    const r = s.file("vault.txt");
    assert.equal(r.status, "R");
    assert.equal(r.kind, "filtered");
  } finally {
    f.cleanup();
  }
});

const LONG = `${"a".repeat(2048)}PAYLOAD`;

test("a whole-file accept of text the view cuts needs the acknowledgement, for a modified, an added and a renamed file", async () => {
  const f = fixture();
  try {
    const body = Array.from({ length: 100 }, (_, i) => `${String(i).padStart(3, "0")}${"x".repeat(56)}\n`).join("");
    f.write("rn.txt", body);
    f.git("add", "rn.txt");
    f.git("commit", "-q", "-m", "rn");
    f.write("keep.txt", `keep\n${LONG}\n`);
    f.write("added.txt", `${LONG}\n`);
    f.git("mv", "rn.txt", "moved.txt");
    f.write("moved.txt", body.replace("001", `${LONG}`));
    const s = await ReviewSession.start(f.deps, { worktree: f.wt, against: f.head() });
    assert.equal(s.file("moved.txt").status, "R");
    for (const p of ["keep.txt", "added.txt", "moved.txt"]) {
      assert.equal(await s.hasCutLines(p), true, p);
      s.reset();
      s.acceptFile(p);
      const e = await refusal(s.build());
      assert.equal(e.details?.["reason"], "truncated_hunk", p);
      s.acceptFile(p, { acceptTruncated: true });
      assert.ok((await s.build()).reviewedTree, p);
    }
    f.write("plain.txt", "short\n");
    const s2 = await ReviewSession.start(f.deps, { worktree: f.wt, against: f.head() });
    s2.reset();
    s2.acceptFile("plain.txt");
    assert.equal(await s2.hasCutLines("plain.txt"), false);
    assert.ok((await s2.build()).reviewedTree, "an ordinary file needs no acknowledgement");
  } finally {
    f.cleanup();
  }
});

test("accepting every hunk one by one, each acknowledged, is not asked about again at build", async () => {
  const f = fixture();
  try {
    f.write("a.txt", BASE.replace("l2\n", `${LONG}\n`));
    const s = await ReviewSession.start(f.deps, { worktree: f.wt, against: f.head() });
    const h = (await s.hunks("a.txt")).hunks ?? [];
    for (const x of h) s.acceptHunk("a.txt", x.id, { acceptTruncated: true });
    assert.ok((await s.build()).reviewedTree);
  } finally {
    f.cleanup();
  }
});

test("a CRLF line of exactly the view's width is not 'cut', and a cut context line is not accepted content", async () => {
  const f = fixture();
  try {
    const exact = "b".repeat(2048);
    const base = `${exact}\r\nx\r\n${"c".repeat(2049)}\r\ny\r\n`;
    f.write("crlf.txt", base);
    f.git("add", "crlf.txt");
    f.git("commit", "-q", "-m", "crlf");
    f.write("crlf.txt", base.replace("x\r\n", "X\r\n"));
    const s = await ReviewSession.start(f.deps, { worktree: f.wt, against: f.head() });
    const h = (await s.hunks("crlf.txt")).hunks ?? [];
    assert.equal(h[0]?.lines.every((l) => !l.truncated || l.kind === " "), true);
    assert.equal(h[0]?.truncated, false, "only added and removed lines count, and the CR is not text");
    s.acceptHunk("crlf.txt", h[0]?.id ?? "");
  } finally {
    f.cleanup();
  }
});

test("a conflicted stash pop (unmerged entries, no marker file) is refused on its own", async () => {
  const f = fixture();
  try {
    f.write("a.txt", BASE.replace("l2\n", "S2\n"));
    f.git("stash", "push", "-q", "-m", "mine");
    f.write("a.txt", BASE.replace("l2\n", "C2\n"));
    f.git("commit", "-q", "-a", "-m", "other");
    try {
      f.git("stash", "pop");
    } catch {
      /* the conflict is the point */
    }
    assert.notEqual(f.git("ls-files", "-u").trim(), "");
    f.write("a.txt", BASE.replace("l2\n", "R2\n"));
    const s = await ReviewSession.start(f.deps, { worktree: f.wt, against: f.head() });
    s.acceptFile("a.txt");
    const b = await s.build();
    assert.equal((await refusal(prepareCommit(f.deps, b))).details?.["reason"], "operation_in_progress");
  } finally {
    f.cleanup();
  }
});

test("the hand-over refuses an operation that began after prepare", async () => {
  const f = fixture();
  try {
    f.write("a.txt", BASE.replace("l2\n", "L2\n"));
    const s = await ReviewSession.start(f.deps, { worktree: f.wt, against: f.head() });
    s.acceptFile("a.txt");
    const prepared = await prepareCommit(f.deps, await s.build());
    writeFileSync(join(f.repo, ".git", "MERGE_HEAD"), `${f.head()}\n`);
    assert.equal((await refusal(prepared.handoff("m"))).details?.["reason"], "operation_in_progress");
  } finally {
    f.cleanup();
  }
});
