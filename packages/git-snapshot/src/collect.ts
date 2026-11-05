// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { stat } from "node:fs/promises";
import { collectConfigs } from "./configs.js";
import { computeDigest } from "./digest.js";
import { escapeDisplay } from "./display.js";
import { record, recordTree, type Ctx } from "./entry.js";
import { SnapshotError, invalid } from "./errors.js";
import { listDir } from "./fsread.js";
import { askGit, resolveGit, type GitView } from "./git.js";
import { Budget, Exhausted, resolveLimits, type Limits } from "./limits.js";
import { isWithin, realish, samePath } from "./paths.js";
import { collectRefs } from "./refs.js";
import type { Incomplete, Snapshot, SnapshotEntry, WorktreeLink } from "./types.js";

export interface TakeOptions {
  /** Absolute path of the worktree (the directory that holds its `.git` file). */
  readonly worktreePath: string;
  /** Absolute path of `$GIT_COMMON_DIR`. */
  readonly commonDir: string;
  /** The worktree's git dir as the journal recorded it. A different `.git` file target is then refused. */
  readonly expectedGitDir?: string;
  /** Other checkouts of the repository (for the in-worktree note on `core.hooksPath`). */
  readonly extraWorktreeRoots?: readonly string[];
  /** For `~/` in config values. Defaults to the current user's home directory. */
  readonly homeDir?: string;
  readonly limits?: Partial<Limits>;
  readonly signal?: AbortSignal;
  /**
   * Absolute path of `git`, resolved once by the caller outside every worktree. When absent, the first absolute
   * `PATH` entry that holds an executable `git` outside the worktrees is used; a bare `git` is never started.
   */
  readonly gitPath?: string;
  /** The environment git is started from (only the GIT-ENV-1 allow-list is passed on). Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Tests only. */
  readonly now?: () => number;
}

// A hook driver in the worktree: editing it changes what an Axis commit runs while `config` stays the same.
const DRIVER_DIRS = [".husky", ".githooks"];
const DRIVER_FILES = [
  "lefthook.yml",
  "lefthook.yaml",
  ".lefthook.yml",
  ".lefthook.yaml",
  "lefthook-local.yml",
  "lefthook-local.yaml",
  ".lefthook-local.yml",
  ".lefthook-local.yaml",
  ".pre-commit-config.yaml",
];

async function insideAny(p: string, roots: readonly string[]): Promise<boolean> {
  const real = await realish(p);
  for (const r of roots) if (isWithin(await realish(r), real) || isWithin(resolve(r), resolve(p))) return true;
  return false;
}

function absolute(p: unknown, what: string): string {
  if (typeof p !== "string" || p.length === 0 || p.length > 4096 || p.includes("\0") || !isAbsolute(p)) {
    throw invalid(`${what} must be an absolute path`);
  }
  return resolve(p);
}

/**
 * Takes the GIT-SNAP-1 snapshot of one worktree and its common dir. Reads files and asks git read-only questions (see `askGit`). Every bound in
 * `Limits` applies, and an item that cannot be read in full is recorded as incomplete, never skipped. Rejects only
 * for bad arguments, a missing common dir, or cancellation.
 */
export async function takeSnapshot(opts: TakeOptions): Promise<Snapshot> {
  const worktreePath = absolute(opts.worktreePath, "worktreePath");
  const commonDir = absolute(opts.commonDir, "commonDir");
  const expected = opts.expectedGitDir === undefined ? undefined : absolute(opts.expectedGitDir, "expectedGitDir");
  const limits = resolveLimits(opts.limits);
  const isDir = await stat(commonDir).then((s) => s.isDirectory(), () => false);
  if (!isDir) throw new SnapshotError("E_NOT_FOUND", "the git common dir does not exist");

  const budget = new Budget(limits, opts.signal);
  const entries = new Map<string, SnapshotEntry>();
  const ctx: Ctx = { limits, budget, entries, settings: [], incomplete: [], homeDir: opts.homeDir ?? homedir() };
  const roots = [worktreePath, ...(opts.extraWorktreeRoots ?? []).map((r) => absolute(r, "extraWorktreeRoots"))];
  if (basename(commonDir) === ".git") roots.push(dirname(commonDir));
  let link: WorktreeLink = { declared: null, expected: expected ?? null, mismatch: true };
  let refs: Snapshot["refs"] = [];
  const refsIncomplete: Incomplete[] = [];

  try {
    const names: string[] = [];
    const env = opts.env ?? process.env;
    const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH");
    let gitPath: string | null = null;
    if (opts.gitPath !== undefined) {
      gitPath = absolute(opts.gitPath, "gitPath");
      if (await insideAny(gitPath, roots)) throw invalid("gitPath must be outside every worktree");
    } else {
      gitPath = await resolveGit(pathKey === undefined ? undefined : env[pathKey], roots);
    }
    const view: GitView =
      gitPath === null
        ? { discovered: { gitDir: null, commonDir: null, topLevel: null }, config: null, hooksDir: null, problems: ["git was not found outside the worktrees"] }
        : await askGit({ worktree: worktreePath, gitDir: expected ?? null, commonDir, home: ctx.homeDir, env, gitPath, budget, limits });
    for (const p of view.problems) ctx.incomplete.push({ id: "git", reason: p, blocking: true });
    link = await collectLink(ctx, worktreePath, commonDir, expected, names, view);
    // Relative paths start where git runs hooks: its own top level, which `core.worktree` can move.
    const top = view.discovered.topLevel ?? worktreePath;
    const targets = await collectConfigs(ctx, { commonDir, worktreePath: top, worktreeRoots: [...roots, top], worktreeNames: names, git: view });
    // Hook scripts can dispatch to subdirectories (pre-commit.d/*): walk them like any in-tree hook directory.
    await recordTree(ctx, "hooks", "hooks", join(commonDir, "hooks"), limits.maxWalkDepth, true);
    if (view.hooksDir !== null && view.hooksDir !== join(commonDir, "hooks")) targets.push({ kind: "hooks", path: view.hooksDir });
    const seen = new Set<string>();
    for (const t of targets) {
      if (t.kind === "hooks" && !seen.has(t.path)) {
        seen.add(t.path);
        await recordTree(ctx, `hookspath:${escapeDisplay(t.path)}`, "in-tree-hooks", t.path, limits.maxWalkDepth, true);
      }
    }
    for (const d of DRIVER_DIRS) {
      await recordTree(ctx, `intree:${d}`, "in-tree-hooks", join(worktreePath, d), limits.maxWalkDepth, true);
    }
    for (const f of DRIVER_FILES) await record(ctx, `intree:${f}`, "in-tree-hooks", join(worktreePath, f));
    await record(ctx, "info/attributes", "attributes", join(commonDir, "info", "attributes"));
    await record(ctx, "info/exclude", "attributes", join(commonDir, "info", "exclude"));
    for (const t of targets) {
      if (t.kind === "attributes") await record(ctx, `attrfile:${escapeDisplay(t.path)}`, "attributes", t.path);
    }
    const r = await collectRefs(commonDir, budget, limits);
    refs = r.refs;
    refsIncomplete.push(...r.incomplete);
  } catch (e) {
    if (!(e instanceof Exhausted)) throw e;
    ctx.incomplete.push({ id: "snapshot", reason: `stopped at the ${e.bound} limit`, blocking: true });
  }

  const sorted = [...entries.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const seenGap = new Set<string>();
  const incomplete = [...ctx.incomplete, ...refsIncomplete].filter((i) => {
    const k = JSON.stringify([i.id, i.reason, i.blocking]);
    return seenGap.has(k) ? false : (seenGap.add(k), true);
  });
  return {
    version: 2,
    takenAtMs: (opts.now ?? Date.now)(),
    worktreePath,
    commonDir,
    entries: sorted,
    settings: ctx.settings,
    refs,
    incomplete,
    link,
    digest: computeDigest(sorted, link, incomplete),
  };
}

/**
 * The worktree's `.git` file (hashed byte for byte) and `worktrees/<name>/{gitdir,commondir}` for every linked
 * worktree. Where the worktree really points is what git itself finds from inside it, not a reading of the file: a
 * terminal `git` follows that, and so must the check. Any difference from the recorded git dir or from the common
 * dir the snapshot was asked about is a mismatch, which is refused and cannot be acknowledged.
 */
async function collectLink(
  ctx: Ctx,
  worktreePath: string,
  commonDir: string,
  expected: string | undefined,
  names: string[],
  view: GitView,
): Promise<WorktreeLink> {
  await record(ctx, "worktree/.git", "link", join(worktreePath, ".git"));
  const list = await listDir(join(commonDir, "worktrees"), ctx.budget, ctx.limits.maxWorktrees);
  if (list.ok) {
    for (const hex of list.undecodable) {
      ctx.incomplete.push({ id: `worktrees/${hex}`, reason: "name is not valid UTF-8, so it was not read", blocking: true });
    }
    for (const name of list.names) {
      names.push(name);
      const base = `worktrees/${escapeDisplay(name)}`;
      await record(ctx, `${base}/gitdir`, "link", join(commonDir, "worktrees", name, "gitdir"));
      await record(ctx, `${base}/commondir`, "link", join(commonDir, "worktrees", name, "commondir"));
    }
  } else if (list.detail !== "missing") {
    ctx.incomplete.push({ id: "worktrees", reason: `unreadable (${list.detail})`, blocking: true });
  }
  const { gitDir, commonDir: found, topLevel } = view.discovered;
  // A top level that is not the worktree (core.worktree in config.worktree) means git runs hooks from somewhere else.
  let mismatch =
    gitDir === null || found === null || topLevel === null || !(await samePath(found, commonDir)) || !(await samePath(topLevel, worktreePath));
  if (!mismatch && expected !== undefined && gitDir !== null) mismatch = !(await samePath(gitDir, expected));
  return { declared: gitDir, expected: expected ?? null, mismatch };
}

export interface StableOptions extends TakeOptions {
  /** Snapshots to try before giving up. Default 3. */
  readonly attempts?: number;
}

/**
 * Takes snapshots until two in a row have the same digest, so a re-take before commit or push is one state and not
 * a mix of two. Returns an incomplete (never acknowledgeable) result when the digest keeps changing.
 */
export async function takeStableSnapshot(opts: StableOptions): Promise<Snapshot> {
  const attempts = Math.min(Math.max(opts.attempts ?? 3, 2), 10);
  let prev = await takeSnapshot(opts);
  for (let i = 1; i < attempts; i++) {
    const next = await takeSnapshot(opts);
    if (next.digest === prev.digest) return next;
    prev = next;
  }
  const incomplete = [...prev.incomplete, { id: "snapshot", reason: "changed between consecutive snapshots", blocking: true }];
  return { ...prev, incomplete, digest: computeDigest(prev.entries, prev.link, incomplete) };
}
