// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Builds the REVIEWED TREE (design §5): the base tree plus exactly the accepted changes, in a temporary index, from
// immutable objects. The worktree, the real index and the refs are not touched.
import { internal, conflict, denied } from "./errors.js";
import { OBJECT_ID, expectComplete, expectOk, type ReviewGit } from "./gitcall.js";
import { parseRaw } from "./changes.js";
import { applyHunks, blobOid, type Hunk } from "./hunks.js";
import type { ReviewDeps, ReviewFile } from "./types.js";

/** What the user decided about one file. */
export interface FileDecision {
  /** The whole change: content, mode, rename, delete, type. */
  readonly whole: boolean;
  /** Accepted hunks of a text file, when not `whole`. */
  readonly hunks: ReadonlySet<number>;
}

interface State {
  readonly mode: string;
  readonly oid: string;
}

export interface BuildInput {
  readonly againstTree: string;
  readonly files: ReadonlyMap<string, ReviewFile>;
  /** Hunks per path, for every file with a partial decision. */
  readonly hunks: ReadonlyMap<string, readonly Hunk[]>;
  readonly decisions: ReadonlyMap<string, FileDecision>;
}

export interface BuildResult {
  readonly reviewedTree: string;
  readonly accepted: readonly { readonly path: string; readonly oldPath?: string; readonly status: string; readonly partial: boolean; readonly hunks: readonly number[] }[];
}

function indexLine(mode: string, oid: string, path: string): string {
  return `${mode} ${oid}\t${path}\0`;
}

async function blobText(git: ReviewGit, oid: string): Promise<string> {
  return expectComplete(await git(["cat-file", "blob", oid]), "read a file version");
}

/** The state a path has in the base tree, as far as the changed-file list knows it. */
function baselineOf(f: ReviewFile, side: "path" | "old"): State | null {
  if (side === "path") return f.status === "A" || f.status === "R" ? null : { mode: f.oldMode, oid: f.oldOid };
  return { mode: f.oldMode, oid: f.oldOid };
}

export async function buildReviewedTree(deps: ReviewDeps, git: ReviewGit, input: BuildInput): Promise<BuildResult> {
  const removals: string[] = [];
  const additions: string[] = [];
  const expected = new Map<string, State | null>();
  const baseline = new Map<string, State | null>();
  const accepted: BuildResult["accepted"][number][] = [];
  let zero = "";

  const remove = (path: string, zeroOid: string): void => {
    removals.push(indexLine("0", zeroOid, path));
    expected.set(path, null);
  };
  const put = (path: string, mode: string, oid: string): void => {
    additions.push(indexLine(mode, oid, path));
    expected.set(path, { mode, oid });
  };

  for (const [path, dec] of input.decisions) {
    const f = input.files.get(path);
    if (!f) throw internal("a decision names a file that is not in the review");
    if (f.unsafePath) throw denied("a file with an unusable path cannot be accepted", "unsafe_path");
    zero = "0".repeat(f.newOid.length);
    baseline.set(path, baselineOf(f, "path"));
    if (f.oldPath !== undefined) baseline.set(f.oldPath, baselineOf(f, "old"));

    if (dec.whole) {
      if (f.status === "D") remove(path, zero);
      else {
        if (f.oldPath !== undefined) remove(f.oldPath, zero);
        put(path, f.newMode, f.newOid);
      }
      accepted.push({ path, ...(f.oldPath === undefined ? {} : { oldPath: f.oldPath }), status: f.status, partial: false, hunks: [] });
      continue;
    }

    const hunks = input.hunks.get(path);
    if (!hunks || dec.hunks.size === 0 || f.fileLevelReason !== undefined) throw internal("a partial decision has no hunks to apply");
    const text = applyHunks(await blobText(git, f.oldOid), hunks, dec.hunks);
    if (text === null) throw conflict("the accepted hunks no longer apply to the file", "hunks_do_not_apply");
    const written = expectOk(await git(["hash-object", "-w", "--no-filters", "--stdin"], { stdin: text }), "store the accepted content").trim();
    if (!OBJECT_ID.test(written) || written !== blobOid(text, f.oldOid.length)) throw internal("the stored content does not match what was computed");
    if (f.oldPath !== undefined) remove(f.oldPath, zero);
    // A content-only decision keeps the old mode; the new one belongs to a whole-file accept.
    put(path, f.oldMode, written);
    accepted.push({ path, ...(f.oldPath === undefined ? {} : { oldPath: f.oldPath }), status: f.status, partial: true, hunks: [...dec.hunks].sort((a, b) => a - b) });
  }
  if (accepted.length === 0) throw denied("nothing is accepted", "nothing_accepted");

  const idx = await deps.tempIndex.create();
  let reviewedTree: string;
  try {
    expectOk(await git(["read-tree", input.againstTree], { index: idx.path }), "read the base tree");
    // Removals first, so a delete of `x` and an add of `x/y` cannot clash. NUL-terminated: any path is safe here.
    const upd = await git(["update-index", "-z", "--index-info"], { index: idx.path, stdin: [...removals, ...additions].join("") });
    if (upd.code !== 0 || /Ignoring path/.test(upd.stderr)) throw conflict("git refused an accepted path", "index_refused");
    reviewedTree = expectOk(await git(["write-tree"], { index: idx.path }), "write the reviewed tree").trim();
  } finally {
    try {
      await idx.dispose();
    } catch {
      /* the provider's to clean up */
    }
  }
  if (!OBJECT_ID.test(reviewedTree)) throw internal("git did not return a tree id for the reviewed tree");
  await verify(git, input.againstTree, reviewedTree, expected, baseline);
  return { reviewedTree, accepted };
}

/**
 * `update-index --index-info` ignores an unusable path and still exits 0, so the tree is never trusted as written: the
 * difference between the base and the reviewed tree must be exactly the accepted changes, no more and no less.
 */
async function verify(
  git: ReviewGit,
  againstTree: string,
  reviewedTree: string,
  expected: ReadonlyMap<string, State | null>,
  baseline: ReadonlyMap<string, State | null>,
): Promise<void> {
  const out = expectComplete(
    await git(["diff-tree", "-r", "-z", "--raw", "--no-abbrev", "--no-renames", "--no-ext-diff", "--no-textconv", againstTree, reviewedTree]),
    "verify the reviewed tree",
  );
  const { entries, overflow } = parseRaw(out, expected.size + 1);
  if (overflow) throw internal("the reviewed tree differs from the base in more places than were accepted");
  const actual = new Map<string, State | null>();
  for (const e of entries) actual.set(e.path, e.status === "D" ? null : { mode: e.newMode, oid: e.newOid });
  for (const [path, want] of expected) {
    const base = baseline.get(path) ?? null;
    const same = (a: State | null, b: State | null): boolean => (a === null || b === null ? a === b : a.mode === b.mode && a.oid === b.oid);
    if (same(want, base)) {
      if (actual.has(path)) throw internal("the reviewed tree changes a file that was not accepted");
      continue;
    }
    const got = actual.get(path);
    if (got === undefined && !actual.has(path)) throw internal("an accepted change is missing from the reviewed tree");
    if (!same(want, got ?? null)) throw internal("an accepted change differs in the reviewed tree");
  }
  for (const path of actual.keys()) {
    if (!expected.has(path)) throw internal("the reviewed tree changes a file that was not accepted");
  }
}
