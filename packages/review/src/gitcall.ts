// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Every git call in this package: daemon context, the hardened prefix from @axis/git-ops, filters neutralised, the
// GIT-ENV-1 environment. GIT_INDEX_FILE is added to the environment of a call that names a temporary index and is
// never present otherwise. (@axis/git-ops does not export its own caller, so this is rebuilt from what it exports;
// see docs/design/review-core.md §6, G4.)
import { isAbsolute as posixAbs, join as posixJoin, normalize as posixNorm } from "node:path/posix";
import { isAbsolute as winAbs, join as winJoin, normalize as winNorm } from "node:path/win32";
import {
  daemonGitEnv,
  filterNames,
  guardedRunner,
  prefix,
  requireGitVersion,
  type GitRunResult,
  type WorktreeRef,
} from "@axis/git-ops";
import { invalid, stderrSnippet, unavailable } from "./errors.js";
import type { ReviewDeps } from "./types.js";

export const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export interface GitCallOptions {
  readonly stdin?: string;
  /** Absolute path of a temporary index: sets GIT_INDEX_FILE and turns sparse checkout off for the call. */
  readonly index?: string;
}

export interface ReviewGit {
  (sub: readonly string[], opts?: GitCallOptions): Promise<GitRunResult>;
}

function platformOf(deps: ReviewDeps): NodeJS.Platform {
  return deps.git.platform ?? process.platform;
}

export function assertWorktree(w: WorktreeRef, platform: NodeJS.Platform): void {
  for (const [what, p] of [["work tree", w?.workTree], ["git directory", w?.gitDir]] as const) {
    if (typeof p !== "string" || p.length === 0 || p.includes("\0")) throw invalid(`the ${what} must be a normalised absolute path`);
    const abs = platform === "win32" ? winAbs(p) : posixAbs(p);
    const norm = platform === "win32" ? winNorm(p) : posixNorm(p);
    const trim = (s: string): string => s.replace(/[\\/]+$/, "");
    if (!abs || trim(norm) !== trim(p)) throw invalid(`the ${what} must be a normalised absolute path`);
  }
}

export function assertOid(value: unknown, what: string): string {
  if (typeof value !== "string" || !OBJECT_ID.test(value)) throw invalid(`${what} must be a full lower-case object id`);
  return value;
}

/** A git caller bound to one worktree. Costs two processes to build (filter names; the version check is cached per runner). */
export async function reviewGitFor(deps: ReviewDeps, w: WorktreeRef): Promise<ReviewGit> {
  const platform = platformOf(deps);
  assertWorktree(w, platform);
  const env = daemonGitEnv(deps.git.env.daemon, platform);
  await requireGitVersion(deps.git, w, env);
  const filters = await filterNames(w, deps.git, env);
  const runner = guardedRunner(deps.git.runner, deps.git);
  const head = prefix(w, deps.git, { context: "daemon", hooks: false, filters });
  return (sub, opts = {}) => {
    const index = opts.index;
    if (index !== undefined && (index.includes("\0") || !(platform === "win32" ? winAbs(index) : posixAbs(index)))) {
      return Promise.reject(invalid("a temporary index must be an absolute path"));
    }
    return runner.run({
      argv: [...head, ...(index === undefined ? [] : ["-c", "core.sparseCheckout=false"]), ...sub],
      cwd: w.workTree,
      env: index === undefined ? env : { ...env, GIT_INDEX_FILE: index },
      context: "daemon",
      ...(opts.stdin === undefined ? {} : { stdin: opts.stdin }),
    });
  };
}

/** Output of a call that must succeed and must be complete. */
export function expectComplete(r: GitRunResult, what: string): string {
  if (r.code !== 0) throw unavailable(`could not ${what}: ${stderrSnippet(r.stderr)}`);
  if (r.truncated === true) throw invalid(`the output of "${what}" was too large to review`, "too_large");
  return r.stdout;
}

/** Output of a call that must succeed; a cut-off is the caller's business. */
export function expectOk(r: GitRunResult, what: string): string {
  if (r.code !== 0) throw unavailable(`could not ${what}: ${stderrSnippet(r.stderr)}`);
  return r.stdout;
}

/** `rev-parse --verify <oid>^{<kind>}` for a full object id. */
export async function resolveObject(git: ReviewGit, oid: string, kind: "commit" | "tree"): Promise<string> {
  const r = await git(["rev-parse", "--verify", "--quiet", "--end-of-options", `${oid}^{${kind}}`]);
  const out = r.stdout.trim();
  if (r.code !== 0 || !OBJECT_ID.test(out)) throw invalid(`${kind} ${oid.slice(0, 12)} was not found`, "not_found");
  return out;
}

/** The size of an object, or undefined when git could not say (a failed call is never "size 0"). */
export async function objectSize(git: ReviewGit, oid: string): Promise<number | undefined> {
  const r = await git(["cat-file", "-s", oid]);
  const t = r.stdout.trim();
  return r.code === 0 && /^\d{1,15}$/.test(t) ? Number(t) : undefined;
}

/** Absolute paths of git-directory entries, from `rev-parse --git-path` (so a linked worktree's own directory is used). */
export async function gitPaths(deps: ReviewDeps, git: ReviewGit, w: WorktreeRef, names: readonly string[]): Promise<string[]> {
  const platform = platformOf(deps);
  const where = await git(["rev-parse", ...names.flatMap((n) => ["--git-path", n])]);
  const paths = where.stdout.split("\n");
  if (paths[paths.length - 1] === "") paths.pop();
  if (where.code !== 0 || paths.length !== names.length) throw unavailable("could not find the git directory's state files");
  return paths.map((p) => ((platform === "win32" ? winAbs(p) : posixAbs(p)) ? p : (platform === "win32" ? winJoin : posixJoin)(w.workTree, p)));
}
