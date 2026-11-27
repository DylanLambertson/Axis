// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";

/**
 * The repository binding of a project folder, read WITHOUT git discovery (docs/design/project-registration-and-trust.md §5.2):
 * `@axis/git-ops` refuses a daemon-context git call without an explicit `--git-dir` and `--work-tree` (GIT-4), and nothing a
 * repository's config says may run before it is trusted. A folder `P` is a repository top level when:
 *   1. `P` is its own real path (a symlinked component makes the spellings differ);
 *   2. `P/.git` is a real directory: not a symlink, not a `gitdir:` file (a linked worktree, a submodule checkout, a separate git
 *      directory: one project per object store);
 *   3. `P/.git` has no `commondir` file, and has `HEAD` (a regular file), `objects/` and `refs/` (real directories);
 *   4. `P/.git` is owned by this process's user (the `safe.directory` "dubious ownership" rule, failing closed). Windows has no
 *      `uid`: refused `unavailable`, never skipped, until a Windows ticket specifies the owner-SID check.
 * `commonDir` is `P/.git` (equal to its real path by 1 and 2); `gitDirId` is `<dev>:<ino>` of it, read as bigints so a large inode
 * number keeps every digit. Everything is async under one signal and a time bound: a hung filesystem is `unavailable`.
 */
export interface RepositoryBinding {
  readonly path: string;
  readonly commonDir: string;
  readonly gitDirId: string;
}
export type BindingRefusal = "not_a_repository" | "unavailable";
export type BindingResult = { readonly ok: true; readonly binding: RepositoryBinding } | { readonly ok: false; readonly reason: BindingRefusal };

interface Stat {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
  readonly uid: bigint | number;
  readonly dev: bigint | number;
  readonly ino: bigint | number;
  readonly size: bigint | number;
}
export interface BindingFs {
  realpath(path: string): Promise<string>;
  /** `lstat` with bigint fields; rejects with `code: "ENOENT"` when the entry does not exist. */
  lstat(path: string): Promise<Stat>;
}
export const nodeBindingFs: BindingFs = { realpath: (p) => realpath(p), lstat: (p) => lstat(p, { bigint: true }) };

export interface BindingOptions {
  readonly platform: NodeJS.Platform;
  /** This process's uid (`process.getuid()`); undefined where there is none. */
  readonly uid: number | undefined;
  readonly fs?: BindingFs;
  readonly signal?: AbortSignal;
  /** Default 2000 ms. */
  readonly timeoutMs?: number;
}

export const BINDING_TIMEOUT_MS = 2_000;

const missing = (e: unknown): boolean => (e as { code?: unknown } | null)?.code === "ENOENT";

async function check(path: string, o: BindingOptions, fs: BindingFs, uid: number): Promise<BindingResult> {
  const no: BindingResult = { ok: false, reason: "not_a_repository" };
  if ((await fs.realpath(path)) !== path) return no;
  const gitDir = join(path, ".git");
  let git: Stat;
  try {
    git = await fs.lstat(gitDir);
  } catch (e) {
    if (missing(e)) return no;
    throw e;
  }
  if (git.isSymbolicLink() || !git.isDirectory()) return no;
  if (BigInt(git.uid) !== BigInt(uid)) return no;
  try {
    await fs.lstat(join(gitDir, "commondir"));
    return no;
  } catch (e) {
    if (!missing(e)) throw e;
  }
  const entry = async (name: string, want: "file" | "dir"): Promise<boolean> => {
    try {
      const s = await fs.lstat(join(gitDir, name));
      return !s.isSymbolicLink() && (want === "file" ? s.isFile() : s.isDirectory());
    } catch (e) {
      if (missing(e)) return false;
      throw e;
    }
  };
  if (!(await entry("HEAD", "file")) || !(await entry("objects", "dir")) || !(await entry("refs", "dir"))) return no;
  o.signal?.throwIfAborted();
  return { ok: true, binding: { path, commonDir: gitDir, gitDirId: `${BigInt(git.dev)}:${BigInt(git.ino)}` } };
}

/** Reads the binding of `path` (absolute, normalised). Never throws: every failure is a closed reason. */
export async function readRepositoryBinding(path: string, o: BindingOptions): Promise<BindingResult> {
  if (o.platform === "win32" || o.uid === undefined) return { ok: false, reason: "unavailable" };
  const uid = o.uid;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<BindingResult>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, reason: "unavailable" }), o.timeoutMs ?? BINDING_TIMEOUT_MS);
  });
  const aborted = new Promise<BindingResult>((resolve) => {
    if (o.signal?.aborted) resolve({ ok: false, reason: "unavailable" });
    o.signal?.addEventListener("abort", () => resolve({ ok: false, reason: "unavailable" }), { once: true });
  });
  try {
    const work = check(path, o, o.fs ?? nodeBindingFs, uid).catch((e: unknown): BindingResult => ({ ok: false, reason: missing(e) ? "not_a_repository" : "unavailable" }));
    return await Promise.race([work, bound, aborted]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** T2: the folder is still the repository the row was bound to. A row without a binding (pre-v11) never matches. */
export function bindingMatches(row: { readonly commonDir: string | null; readonly gitDirId: string | null }, binding: RepositoryBinding): boolean {
  return row.commonDir !== null && row.gitDirId !== null && row.commonDir === binding.commonDir && row.gitDirId === binding.gitDirId;
}
