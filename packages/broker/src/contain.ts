// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// WT-1 and DMN-2: resolve a requested path against a registered worktree, then open it without trusting the check.
import { posix, win32 } from "node:path";
import { BrokerError, denied, invalid, toBrokerError } from "./errors.js";
import type { BrokerFile, BrokerFs, FileStat, OpenMode } from "./fs.js";
import { foldName, lexicalSegments, relText, splitNative } from "./lexical.js";
import { matchProtected, type ProtectedMatch } from "./protectedPaths.js";
import type { RegisteredWorktree, WorktreeRegistry } from "./types.js";

export interface ContainDeps {
  readonly registry: WorktreeRegistry;
  readonly fs: BrokerFs;
  readonly platform?: NodeJS.Platform;
  /** Extra root-anchored protected paths (the host's additions to the defaults). */
  readonly extraProtected?: readonly (readonly string[])[];
}

/** How the final component must relate to the file system. */
export type ResolveMode = "read" | "overwrite" | "create" | "upsert" | "dir";

export interface ResolvedRoot {
  readonly worktree: RegisteredWorktree;
  /** The real path of the root, equal to the recorded one. */
  readonly root: string;
}

export interface ResolvedTarget {
  readonly worktreeId: string;
  readonly root: string;
  /** Lexical segments below the root, as requested. */
  readonly segments: readonly string[];
  /** Segments of the real path below the root. */
  readonly realSegments: readonly string[];
  /** Text of `realSegments` for audit and display. */
  readonly rel: string;
  /** The real parent directory and the final name; the path to open is `join(parent, name)`. */
  readonly parent: string;
  readonly name: string;
  /** The final component's identity before any open; undefined when it does not exist yet. */
  readonly before: FileStat | undefined;
  readonly protected: ProtectedMatch | undefined;
}

const platformOf = (d: ContainDeps): NodeJS.Platform => d.platform ?? process.platform;
const libOf = (p: NodeJS.Platform): typeof posix => (p === "win32" ? (win32 as unknown as typeof posix) : posix);

/** True when `child` is `dir` or below it, by whole segments (never a string prefix), folded where the platform folds. */
export function isUnder(child: string, dir: string, platform: NodeJS.Platform): boolean {
  const c = splitNative(child, platform).map((s) => foldName(s, platform));
  const d = splitNative(dir, platform).map((s) => foldName(s, platform));
  return d.length <= c.length && d.every((s, i) => s === c[i]);
}

const same = (a: string, b: string, platform: NodeJS.Platform): boolean => isUnder(a, b, platform) && isUnder(b, a, platform);

async function real(fs: BrokerFs, path: string): Promise<string> {
  try {
    return await fs.realpath(path);
  } catch (e) {
    const code = (e as { code?: unknown } | null)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") throw denied("not-found", "the path does not exist");
    throw denied("fs-error", "the path could not be resolved");
  }
}

/** DMN-2 at time of use: the id is registered, its root is still the recorded real path, outside every repository. */
export async function resolveRoot(deps: ContainDeps, worktreeId: unknown): Promise<ResolvedRoot> {
  const platform = platformOf(deps);
  if (typeof worktreeId !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(worktreeId)) throw invalid("invalid-call", "the worktree id is not valid");
  const wt = deps.registry.get(worktreeId);
  if (wt === undefined) throw denied("unregistered", "the worktree is not registered");
  const lib = libOf(platform);
  if (typeof wt.root !== "string" || !lib.isAbsolute(wt.root) || wt.root.includes("\0")) throw denied("root-moved", "the worktree root is not valid");
  const actual = await real(deps.fs, wt.root).catch(() => {
    throw denied("root-moved", "the worktree root is not available");
  });
  // A root that is, or sits under, a symlink (for example into the local checkout) no longer resolves to what was registered.
  if (!same(actual, wt.root, platform)) throw denied("root-moved", "the worktree root no longer resolves to its registered path");
  for (const repo of deps.registry.repositoryRoots()) {
    const repoReal = await deps.fs.realpath(repo).catch(() => repo);
    if (isUnder(actual, repo, platform) || isUnder(actual, repoReal, platform)) {
      throw denied("root-in-repository", "the worktree root is inside a registered repository");
    }
  }
  return { worktree: wt, root: actual };
}

/**
 * WT-1: the lexical rules, then the real path of the parent must lie under the real root; a final symlink is followed
 * only to a target that also lies under it. Nothing here is a guarantee against a concurrent swap: `openContained`
 * re-verifies after the open.
 */
export async function resolveTarget(deps: ContainDeps, worktreeId: unknown, input: unknown, mode: ResolveMode): Promise<ResolvedTarget> {
  const platform = platformOf(deps);
  const lib = libOf(platform);
  const { worktree, root } = await resolveRoot(deps, worktreeId);
  const segments = lexicalSegments(input, root, platform);
  const finish = (parent: string, name: string, before: FileStat | undefined, realSegs: string[]): ResolvedTarget => {
    const a = matchProtected(segments, deps.extraProtected, platform);
    const b = matchProtected(realSegs, deps.extraProtected, platform);
    // Either spelling may match; a Git directory match wins because it also gates reads.
    const hit = a?.gitDir === true ? a : b?.gitDir === true ? b : (a ?? b);
    return {
      worktreeId: worktree.id, root, segments, realSegments: realSegs, rel: relText(realSegs), parent, name, before, protected: hit,
    };
  };
  if (segments.length === 0) {
    if (mode !== "dir") throw denied("not-regular", "the path is the worktree root");
    return finish(root, "", undefined, []);
  }
  const name = segments[segments.length - 1] as string;
  const parentReal = await real(deps.fs, lib.join(root, ...segments.slice(0, -1)));
  if (!isUnder(parentReal, root, platform)) throw denied("symlink-escape", "the path leaves the worktree");
  let parent = parentReal;
  let leaf = name;
  const full = lib.join(parent, leaf);
  let before = await deps.fs.lstat(full).catch((e: unknown) => {
    if ((e as { code?: unknown } | null)?.code === "ENOENT") return undefined;
    throw denied("fs-error", "the path could not be inspected");
  });
  if (before?.kind === "symlink") {
    // Follow it only to a target inside the root; the open then uses the resolved name, still with O_NOFOLLOW.
    const target = await real(deps.fs, full).catch((e: unknown) => {
      if (e instanceof BrokerError && e.reason === "not-found") throw denied("symlink-dangling", "the symlink does not resolve");
      throw e;
    });
    if (!isUnder(target, root, platform) || same(target, root, platform)) throw denied("symlink-escape", "the symlink leaves the worktree");
    parent = lib.dirname(target);
    leaf = lib.basename(target);
    before = await deps.fs.lstat(target).catch(() => {
      throw denied("symlink-dangling", "the symlink does not resolve");
    });
    if (before.kind === "symlink") throw denied("symlink-escape", "the symlink does not resolve to a file");
  }
  if (mode === "dir") {
    if (before === undefined || before.kind !== "dir") throw denied("not-found", "the directory does not exist");
  } else if (mode === "read" || mode === "overwrite") {
    if (before === undefined) throw denied("not-found", "the file does not exist");
    if (before.kind !== "file") throw denied("not-regular", "the path is not a regular file");
  } else if (mode === "create") {
    if (before !== undefined) throw denied("exists", "the file already exists");
  } else if (before !== undefined && before.kind !== "file") {
    throw denied("not-regular", "the path is not a regular file");
  }
  const finalPath = lib.join(parent, leaf);
  const realSegs = splitNative(finalPath, platform).slice(splitNative(root, platform).length);
  return finish(parent, leaf, before, realSegs);
}

export interface OpenFile {
  readonly file: BrokerFile;
  readonly stat: FileStat;
  readonly target: ResolvedTarget;
}

/**
 * Opens a resolved target and verifies what was opened before any byte moves: the descriptor is a regular file with
 * the identity seen at check time, the path still names it, the parent still resolves to the same place, and where the
 * kernel can report the descriptor's path it lies under the root. A write also refuses a file with more than one link.
 * On any mismatch the descriptor is closed and the call is refused.
 */
export async function openContained(deps: ContainDeps, target: ResolvedTarget, mode: OpenMode): Promise<OpenFile> {
  const platform = platformOf(deps);
  const lib = libOf(platform);
  const full = lib.join(target.parent, target.name);
  let file: BrokerFile;
  try {
    file = await deps.fs.open(full, mode);
  } catch (e) {
    const code = (e as { code?: unknown } | null)?.code;
    if (code === "ELOOP") throw denied("symlink-escape", "the path is a symlink");
    if (code === "EEXIST") throw denied("exists", "the file already exists");
    if (code === "ENOENT") throw denied("not-found", "the file does not exist");
    throw denied("fs-error", "the file could not be opened");
  }
  try {
    const st = await file.stat();
    if (st.kind !== "file") throw denied("not-regular", "the path is not a regular file");
    if (target.before !== undefined && target.before.id !== st.id) throw denied("swapped", "the file changed while it was being opened");
    // Parent first, then the name: a swap that is undone between the two checks still leaves the second one to see it.
    const parentNow = await real(deps.fs, target.parent).catch(() => {
      throw denied("swapped", "the parent changed while the file was being opened");
    });
    if (!same(parentNow, target.parent, platform) || !isUnder(parentNow, target.root, platform)) {
      throw denied("swapped", "the parent changed while the file was being opened");
    }
    const after = await deps.fs.lstat(full).catch(() => {
      throw denied("swapped", "the file changed while it was being opened");
    });
    if (after.kind !== "file" || after.id !== st.id) throw denied("swapped", "the file changed while it was being opened");
    // Where the kernel reports the descriptor's path (Linux), the file that was opened must be the one that was
    // authorised: the same real path, not merely one below the root (WT-1, WT-3 at the time of use).
    const viaFd = await file.fdPath();
    if (viaFd !== undefined) {
      const want = lib.join(target.root, ...target.realSegments);
      if (!same(viaFd, want, platform)) throw denied("swapped", "the open file is not the authorised path");
    }
    // The link count is read again at the very end: a hard link made after the first fstat (where there is no descriptor
    // path to compare, darwin and win32) would otherwise pass. This narrows that race; it does not close it.
    const last = await file.stat();
    if (last.id !== st.id || last.kind !== "file") throw denied("swapped", "the file changed while it was being opened");
    if (mode !== "read" && (st.nlink > 1 || last.nlink > 1)) throw denied("hardlink", "the file has more than one link");
    return { file, stat: last, target };
  } catch (e) {
    await file.close().catch(() => undefined);
    throw toBrokerError(e);
  }
}

/** Runs on the resolved target before anything is opened; throws to refuse. The broker's use-time policy lives here. */
export type TargetGuard = (target: ResolvedTarget) => void;

export interface ReadOptions {
  readonly maxBytes: number;
  readonly guard?: TargetGuard;
  readonly signal?: AbortSignal;
}
export interface WriteOptions {
  readonly mode: "overwrite" | "create" | "upsert";
  readonly maxBytes: number;
  readonly guard?: TargetGuard;
  readonly signal?: AbortSignal;
}

const cancelled = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted === true) throw new BrokerError("E_CANCELLED", "aborted", "the call was cancelled");
};

function checkLimit(n: unknown): number {
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > 64 * 1024 * 1024) throw invalid("invalid-call", "the size limit is not valid");
  return n;
}

export async function readContained(deps: ContainDeps, worktreeId: string, path: string, o: ReadOptions): Promise<Buffer> {
  const max = checkLimit(o.maxBytes);
  cancelled(o.signal);
  const target = await resolveTarget(deps, worktreeId, path, "read");
  o.guard?.(target);
  cancelled(o.signal);
  const { file, stat } = await openContained(deps, target, "read");
  try {
    if (stat.size > max) throw denied("too-large", "the file is larger than the limit");
    const data = await file.read(max + 1);
    if (data.length > max) throw denied("too-large", "the file is larger than the limit");
    return data;
  } catch (e) {
    throw toBrokerError(e);
  } finally {
    await file.close().catch(() => undefined);
  }
}

export async function writeContained(deps: ContainDeps, worktreeId: string, path: string, data: Uint8Array, o: WriteOptions): Promise<{ readonly bytes: number; readonly rel: string }> {
  const max = checkLimit(o.maxBytes);
  if (!(data instanceof Uint8Array) || data.length > max) throw denied("too-large", "the content is larger than the limit");
  cancelled(o.signal);
  const target = await resolveTarget(deps, worktreeId, path, o.mode);
  o.guard?.(target);
  cancelled(o.signal);
  const { file } = await openContained(deps, target, o.mode);
  try {
    cancelled(o.signal);
    // Truncate only now: the descriptor has been verified, so an outside file is never emptied by a swapped symlink.
    await file.truncate(0);
    await file.write(data);
    return { bytes: data.length, rel: target.rel };
  } catch (e) {
    throw toBrokerError(e);
  } finally {
    await file.close().catch(() => undefined);
  }
}
