// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Third independent review: attribute sources outside the tree (SF-A), every accept route through build() (SF-B), the
// hand-off in git-ops' shape (SF-C), and the CRLF, symlink-target and reason nits.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CommitInput } from "@axis/git-ops";
import { ReviewSession, prepareCommit, type PinnedCommitInput } from "../src/index.js";
import { fixture, refusal, type Fixture } from "./fixture.js";
import { PASS, REVERSE, withFilter } from "./filters.js";

const posix = process.platform !== "win32";
const BASE = Array.from({ length: 20 }, (_, i) => `l${i + 1}\n`).join("");
const LONG = `${"a".repeat(2048)}PAYLOAD`;

function vault(): Fixture {
  return fixture({ base: (a) => withFilter(REVERSE, PASS)(a) });
}

function globalAttributes(f: Fixture, text: string): void {
  mkdirSync(join(f.home, ".config", "git"), { recursive: true });
  writeFileSync(join(f.home, ".config", "git", "attributes"), text);
}

function infoAttributes(f: Fixture, text: string): void {
  mkdirSync(join(f.repo, ".git", "info"), { recursive: true });
  writeFileSync(join(f.repo, ".git", "info", "attributes"), text);
}

async function untrusted(f: Fixture, path: string): Promise<void> {
  const s = await ReviewSession.start(f.deps, { worktree: f.wt, against: f.head() });
  assert.equal(s.file(path).kind, "filtered");
  assert.equal(s.file(path).fileLevelReason, "attributes_untrusted");
  assert.throws(() => s.acceptFile(path), (e: unknown) => (e as { details?: Record<string, unknown> }).details?.["reason"] === "filtered_path");
}

test("a macro defined in the user's attributes file that switches a filter off, used from info/attributes, is not trusted", { skip: !posix }, async () => {
  const f = vault();
  try {
    globalAttributes(f, "[attr]plain -filter\n");
    infoAttributes(f, "vault.dat plain\n");
    f.write("vault.dat", "API_PASSWORD=hunter2\n");
    await untrusted(f, "vault.dat");
  } finally {
    f.cleanup();
  }
});

test("the same macro in a file named by core.attributesFile is not trusted", { skip: !posix }, async () => {
  const f = vault();
  try {
    writeFileSync(join(f.root, "extra-attributes"), "[attr]plain -filter\nvault.dat plain\n");
    f.git("config", "core.attributesFile", join(f.root, "extra-attributes"));
    f.write("vault.dat", "API_PASSWORD=hunter2\n");
    await untrusted(f, "vault.dat");
  } finally {
    f.cleanup();
  }
});

test("redefining a macro the base tree uses, in the user's attributes file, is not trusted", { skip: !posix }, async () => {
  const f = fixture({ base: (a) => { withFilter(REVERSE, PASS)(a); a.write(".gitattributes", "*.dat crypt\n"); a.git("config", "filter.vault.required", "false"); } });
  try {
    globalAttributes(f, "[attr]crypt -filter\n");
    f.write("vault.dat", "API_PASSWORD=hunter2\n");
    await untrusted(f, "vault.dat");
  } finally {
    f.cleanup();
  }
});

test("a macro-less attribute line in info/attributes is not trusted either, but a comment-only file is", { skip: !posix }, async () => {
  const f = vault();
  try {
    infoAttributes(f, "vault.dat plain\n");
    f.write("vault.dat", "x\n");
    await untrusted(f, "vault.dat");
    infoAttributes(f, "# a comment that mentions filter and nothing else\n\n");
    const s = await ReviewSession.start(f.deps, { worktree: f.wt, against: f.head() });
    assert.equal(s.file("vault.dat").fileLevelReason, "filtered_path", "the file is filtered by its own attribute, not because of the comment");
    assert.equal(s.file("vault.dat").kind, "filtered");
  } finally {
    f.cleanup();
  }
});

test("an ordinary user attributes file (no macro, no filter) leaves the review as it was", { skip: !posix }, async () => {
  const f = fixture();
  try {
    globalAttributes(f, "*.log text\n");
    f.write("a.txt", BASE.replace("l2\n", "L2\n"));
    const s = await ReviewSession.start(f.deps, { worktree: f.wt, against: f.head() });
    assert.equal(s.file("a.txt").kind, "text");
    s.acceptFile("a.txt");
  } finally {
    f.cleanup();
  }
});

test("flipping core.ignorecase after the commit does not make a filtered file look plain", { skip: !posix }, async () => {
  const f = fixture({
    base: (a) => {
      withFilter(REVERSE, PASS)(a);
      a.git("config", "core.ignorecase", "true");
      a.write(".gitattributes", "secret.env filter=vault\n");
      a.write("SECRET.ENV", "stored reversed\n");
    },
  });
  try {
    f.git("config", "core.ignorecase", "false");
    f.write("SECRET.ENV", "API_PASSWORD=hunter2\n");
    const s = await ReviewSession.start(f.deps, { worktree: f.wt, against: f.head() });
    assert.equal(s.file("SECRET.ENV").kind, "filtered");
    assert.equal(s.file("SECRET.ENV").fileLevelReason, "filtered_path");
  } finally {
    f.cleanup();
  }
});

async function twoHunks(f: Fixture): Promise<ReviewSession> {
  f.write("a.txt", BASE.replace("l2\n", `${LONG}\n`).replace("l18\n", "L18\n"));
  const s = await ReviewSession.start(f.deps, { worktree: f.wt, against: f.head() });
  const h = (await s.hunks("a.txt")).hunks ?? [];
  assert.equal(h.length, 2);
  assert.equal(h[0]?.truncated, true);
  return s;
}

test("acceptFile, then rejecting the other hunk, does not carry a cut hunk past build()", async () => {
  const f = fixture();
  try {
    const s = await twoHunks(f);
    const h = (await s.hunks("a.txt")).hunks ?? [];
    s.acceptFile("a.txt");
    s.rejectHunk("a.txt", h[1]?.id ?? "");
    assert.equal((await refusal(s.build())).details?.["reason"], "truncated_hunk");
  } finally {
    f.cleanup();
  }
});

test("every accept route that leaves a cut hunk in the set is refused at build() unless that hunk was acknowledged", async () => {
  const f = fixture();
  try {
    const s = await twoHunks(f);
    const h = (await s.hunks("a.txt")).hunks ?? [];
    const cut = h[0]?.id ?? "";
    const other = h[1]?.id ?? "";
    // The cut hunk accepted alone is refused at the hunk.
    assert.throws(() => s.acceptHunk("a.txt", cut), (e: unknown) => (e as { details?: Record<string, unknown> }).details?.["reason"] === "truncated_hunk");
    // Acknowledged whole file, then the other hunk rejected: the acknowledgement is kept for what remains.
    s.acceptFile("a.txt", { acceptTruncated: true });
    s.rejectHunk("a.txt", other);
    assert.ok((await s.build()).reviewedTree);
    // Acknowledged hunk, then the file accepted without it and the other hunk rejected: refused.
    s.reset();
    s.acceptHunk("a.txt", cut, { acceptTruncated: true });
    s.acceptFile("a.txt");
    s.rejectHunk("a.txt", other);
    assert.equal((await refusal(s.build())).details?.["reason"], "truncated_hunk");
    // Only the other hunk: nothing cut is accepted, so no acknowledgement is asked for.
    s.reset();
    s.acceptHunk("a.txt", other);
    assert.ok((await s.build()).reviewedTree);
    // The cut hunk acknowledged on its own.
    s.reset();
    s.acceptHunk("a.txt", cut, { acceptTruncated: true });
    assert.ok((await s.build()).reviewedTree);
  } finally {
    f.cleanup();
  }
});

test("a CRLF added line of exactly the view's width is not cut, and one character more is", async () => {
  const f = fixture();
  try {
    f.write("exact.txt", `${"b".repeat(2048)}\r\n`);
    f.write("over.txt", `${"b".repeat(2049)}\r\n`);
    const s = await ReviewSession.start(f.deps, { worktree: f.wt, against: f.head() });
    assert.equal(await s.hasCutLines("exact.txt"), false, "the CR is not text");
    assert.equal(await s.hasCutLines("over.txt"), true);
  } finally {
    f.cleanup();
  }
});

test("a symlink target longer than the view shows needs the acknowledgement", { skip: !posix }, async () => {
  const f = fixture();
  try {
    symlinkSync(`${"d/".repeat(600)}PAYLOAD`, join(f.repo, "long-link"));
    symlinkSync("keep.txt", join(f.repo, "short-link"));
    const s = await ReviewSession.start(f.deps, { worktree: f.wt, against: f.head() });
    assert.equal(s.file("long-link").link?.targetCut, true);
    assert.equal(await s.hasCutLines("long-link"), true);
    assert.equal(await s.hasCutLines("short-link"), false);
    s.acceptFile("long-link");
    assert.equal((await refusal(s.build())).details?.["reason"], "truncated_hunk");
    s.acceptFile("long-link", { acceptTruncated: true });
    assert.ok((await s.build()).reviewedTree);
  } finally {
    f.cleanup();
  }
});

test("handoff() returns git-ops' shape: a full parent id and the short branch name, assignable to CommitInput", async () => {
  const f = fixture();
  try {
    f.write("a.txt", BASE.replace("l2\n", "L2\n"));
    const s = await ReviewSession.start(f.deps, { worktree: f.wt, against: f.head() });
    s.acceptFile("a.txt");
    const input: PinnedCommitInput = await (await prepareCommit(f.deps, await s.build())).handoff("m");
    const asGitOps: CommitInput = input; // the compile-level check: the hand-off stays assignable to git-ops' input
    assert.equal(asGitOps.reviewedTreeHash, input.reviewedTreeHash);
    assert.equal(input.expectedParent, f.head());
    assert.equal(input.expectedBranch, "axis/feat");
    assert.equal(input.expectedBranch?.startsWith("refs/"), false);
  } finally {
    f.cleanup();
  }
});

test("handoff() leaves expectedBranch out, not null, when HEAD is detached", async () => {
  const f = fixture();
  try {
    f.git("checkout", "-q", "--detach");
    f.write("a.txt", BASE.replace("l2\n", "L2\n"));
    const s = await ReviewSession.start(f.deps, { worktree: f.wt, against: f.head() });
    s.acceptFile("a.txt");
    const input = await (await prepareCommit(f.deps, await s.build())).handoff("m");
    assert.equal("expectedBranch" in input, false);
    assert.equal(input.expectedParent, f.head());
  } finally {
    f.cleanup();
  }
});

test("a macro whose text never says 'filter' (it names another macro) is still not trusted", { skip: !posix }, async () => {
  const f = vault();
  try {
    globalAttributes(f, "[attr]crypt plain\n");
    f.write("vault.dat", "x\n");
    await untrusted(f, "vault.dat");
  } finally {
    f.cleanup();
  }
});

test("a later -filter line that matches only when core.ignorecase is true does not hide a filter that matched when it was false", { skip: !posix }, async () => {
  const f = fixture({
    base: (a) => {
      withFilter(REVERSE, PASS)(a);
      a.write(".gitattributes", "secret.env filter=vault\nSECRET.ENV -filter\n");
      a.write("secret.env", "stored reversed\n");
    },
  });
  try {
    f.git("config", "core.ignorecase", "true");
    f.write("secret.env", "API_PASSWORD=hunter2\n");
    const s = await ReviewSession.start(f.deps, { worktree: f.wt, against: f.head() });
    assert.equal(s.file("secret.env").kind, "filtered");
  } finally {
    f.cleanup();
  }
});
