// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// PSH-1: scan the patch of every commit that a push will send, not the net change between two trees.
import { createHash } from "node:crypto";
import { OBJECT_ID, type DaemonGit } from "./args.js";
import { GitOpsError, ScanIncomplete } from "./errors.js";
import { messageViews } from "./messageViews.js";
import type { GitOpsDeps, SecretFinding, WorktreeRef } from "./types.js";

/** Per-commit patch size handed to the scanner. */
export const MAX_DIFF = 8 * 1024 * 1024;

/** More commits or bytes than this are not scanned; the scan then reports `truncated` and the caller fails closed. */
export const MAX_COMMITS = 5000;
export const MAX_TOTAL = 128 * 1024 * 1024;

/**
 * One binary path of the outgoing history. `id` is derived here from the path's RAW BYTES (never from the decoded text), so two
 * names that decode to the same lossy string have different ids, and the id is the same on every scan of the same path: a
 * `pushPlan` row and the `push` that follows name one file. `path` is git's spelling decoded as UTF-8 (lossy); `lossy` says it
 * holds U+FFFD, so it cannot be told apart from other names by display and is never waived.
 */
export interface BinaryRow {
  readonly id: string;
  readonly path: string;
  readonly lossy: boolean;
}

/** `bin_` and 32 lower-case hex digits: SHA-256 over a domain tag and the path bytes, cut to 128 bits. */
export const BINARY_ID = /^bin_[0-9a-f]{32}$/;

export function binaryRow(bytes: Buffer): BinaryRow {
  const path = bytes.toString("utf8");
  const id = `bin_${createHash("sha256").update("axis.git.binary-path.v1\0").update(bytes).digest("hex").slice(0, 32)}`;
  return { id, path, lossy: path.includes("\ufffd") };
}

export interface OutgoingScan {
  readonly findings: readonly SecretFinding[];
  /** True when anything outgoing was not scanned: a patch over MAX_DIFF, more than MAX_COMMITS commits, or more than MAX_TOTAL bytes. */
  readonly truncated: boolean;
  /** Every path git treats as binary in any outgoing commit, without duplicates. */
  readonly binaryPaths: readonly string[];
  /** The same files by identity: one row per distinct path BYTES, so names that only look alike stay apart. */
  readonly binaryRows: readonly BinaryRow[];
  /** Commits whose message holds a NUL byte, bytes invalid in its declared encoding, or an unknown encoding, so it cannot be scanned reliably. The caller refuses; none of the text is kept. */
  readonly undecodable: readonly string[];
}

/** Paths whose `git diff-tree --numstat -z` counts are `-\t-`. */
export function parseBinaryPaths(numstat: string): string[] {
  const out: string[] = [];
  for (const rec of numstat.split("\0")) {
    const m = /^-\t-\t([^\0]+)$/.exec(rec.replace(/^\n/, ""));
    if (m) out.push(m[1] as string);
  }
  return out;
}

/** The binary rows of a numstat read raw (one character per byte). Text a runner did not mark raw is already decoded, so its UTF-8 bytes are used. */
function parseBinaryRows(numstat: string, raw: boolean): BinaryRow[] {
  return parseBinaryPaths(numstat).map((p) => binaryRow(Buffer.from(p, raw ? "latin1" : "utf8")));
}

function unavailable(what: string): GitOpsError {
  return new GitOpsError("E_UNAVAILABLE", `could not ${what} for the secret scan`);
}

/**
 * Runs the scanner once per commit in `base..tip`, oldest first. Merge commits are diffed against every parent (-m),
 * so a secret that exists only in a merge resolution is seen. Attributes, textconv, external diff, submodule
 * recursion and rename detection are all off; the content scanned is the content pushed.
 */
export async function scanOutgoing(deps: GitOpsDeps, git: DaemonGit, worktree: WorktreeRef, base: string, tip: string, allowedBinaryPaths: readonly string[] = [], allowedBinaryIds: readonly string[] = []): Promise<OutgoingScan> {
  const scanner = deps.scanner;
  if (!scanner) return { findings: [], truncated: false, binaryPaths: [], binaryRows: [], undecodable: [] };
  const list = await git(["rev-list", "--reverse", "--end-of-options", tip, `^${base}`]);
  if (list.code !== 0) throw unavailable("list the outgoing commits");
  // Output the runner cut off is output the scan never saw: whatever it dropped fails the scan closed.
  let truncated = list.truncated === true;
  const commits = list.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  if (commits.some((c) => !OBJECT_ID.test(c))) throw unavailable("list the outgoing commits");
  // A name with U+FFFD is a lossy decoding: several different files (invalid bytes, or a real U+FFFD) can share it, so no allow-list entry
  // can name one of them. The scanner is never told it is allowed (and `planPush` keeps it blocked).
  const allowedNames = allowedBinaryPaths.filter((p) => !p.includes("\ufffd"));
  const allowedIds = new Set(allowedBinaryIds);
  const findings: SecretFinding[] = [];
  const binary = new Set<string>();
  const rows = new Map<string, BinaryRow>();
  const undecodable: string[] = [];
  let total = 0;
  // A scanner that reports it could not cover the text ends the scan: what follows is unscanned, so the result is incomplete.
  let gaveUp = false;
  const scan = async (text: string, meta: Parameters<typeof scanner>[1]): Promise<readonly SecretFinding[]> => {
    try {
      return await scanner(text, meta);
    } catch (e) {
      if (!(e instanceof ScanIncomplete)) throw e;
      gaveUp = true;
      truncated = true;
      return [];
    }
  };
  if (commits.length > MAX_COMMITS) truncated = true;
  for (const commit of commits.slice(0, MAX_COMMITS)) {
    if (gaveUp) break;
    if (total >= MAX_TOTAL) {
      truncated = true;
      break;
    }
    const d = await git([
      "diff-tree", "-p", "--text", "-m", "--root", "--no-commit-id", "--no-renames", "--no-color", "--no-ext-diff", "--no-textconv",
      "--submodule=short", "--ignore-submodules=all", "--end-of-options", commit,
    ]);
    if (d.code !== 0) throw unavailable("compute the outgoing diff");
    // Without --text, so that git reports what it treats as binary. The patch above is --text and shows it all anyway.
    // Read raw (one character per byte) so the identity of a path is its bytes, not the lossy text.
    const stat = await git([
      "diff-tree", "-r", "--numstat", "-z", "-m", "--root", "--no-commit-id", "--no-renames", "--no-ext-diff", "--no-textconv",
      "--submodule=short", "--ignore-submodules=all", "--end-of-options", commit,
    ], undefined, { raw: true });
    if (stat.code !== 0) throw unavailable("list the binary files");
    const commitRows = parseBinaryRows(stat.stdout, stat.raw === true);
    const binaryPaths = commitRows.map((r) => r.path);
    for (const r of commitRows) {
      binary.add(r.path);
      rows.set(r.id, r);
    }
    // What the scanner may skip: the names the user listed, and the files whose id they listed. A lossy name is never allowed.
    const allowedForScan = [...allowedNames, ...commitRows.filter((r) => !r.lossy && allowedIds.has(r.id)).map((r) => r.path)];
    const cut = d.stdout.length > MAX_DIFF || d.truncated === true;
    total += d.stdout.length;
    if (cut || stat.truncated === true) truncated = true;
    for (const f of await scan(cut ? d.stdout.slice(0, MAX_DIFF) : d.stdout, { worktree, truncated: cut, commit, binaryPaths, allowedBinaryPaths: allowedForScan, part: "patch" })) findings.push({ ...f, commit });
    // Once the scanner gave up nothing else is read or scanned: a later failure must not replace the incomplete result.
    if (gaveUp) break;

    // The commit object, headers and message, is pushed too, and a message is as good a place for a secret as a file.
    const raw = await git(["cat-file", "commit", commit], undefined, { raw: true });
    if (raw.code !== 0 || raw.raw !== true) throw unavailable("read the commit message");
    const cutMessage = raw.stdout.length > MAX_DIFF || raw.truncated === true;
    total += raw.stdout.length;
    if (cutMessage) truncated = true;
    if (raw.stdout.length > 0) {
      const text = cutMessage ? raw.stdout.slice(0, MAX_DIFF) : raw.stdout;
      const { views, undecodable: bad } = messageViews(text);
      if (bad) undecodable.push(commit);
      for (const view of views) {
        for (const f of await scan(view, { worktree, truncated: cutMessage, commit, binaryPaths: [], allowedBinaryPaths: [], part: "message" })) findings.push({ ...f, commit });
        if (gaveUp) break;
      }
    }
  }
  return { findings, truncated, binaryPaths: [...binary], binaryRows: [...rows.values()], undecodable };
}
