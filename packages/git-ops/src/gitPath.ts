// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// CLI-1/CFG-1: the git executable is found by @axis/pty-policy's resolver (the rule the pty launcher uses; @axis/worktrees still has its own, docs/packages.md FU-GIT-RESOLVE), outside every
// worktree, and spawned by absolute path. This file only adds the per-request containment check and the child's PATH.
import { delimiterOf, isInsideAny, isPlainAbsolute, nodeFs, resolveExecutable } from "@axis/pty-policy";
import { denied } from "./errors.js";
import type { GitRunRequest } from "./types.js";

type EnvLike = Readonly<Record<string, string | undefined>>;

/**
 * The host calls this ONCE at daemon start with the daemon's own environment and EVERY registered worktree (and git
 * directory) in `excludeDirs`, so a git planted in a sibling worktree whose folder is on PATH is never chosen. Empty and
 * relative PATH entries are ignored. On win32 UNC, device, root-relative and quoted entries are refused too (a network
 * share would run code from elsewhere and leak credentials), and only `.exe`/`.com` count. Returns an absolute path.
 */
export function resolveGit(env: EnvLike, platform: NodeJS.Platform, excludeDirs: readonly string[] = []): string | undefined {
  return resolveExecutable("git", env, platform, nodeFs, { excludeDirs });
}

// The closed set of git global options a request may carry before the subcommand. Anything else that starts with "-" is
// refused (fail closed): git has value-taking options its usage text does not list (--shallow-file <file>), and one it
// does not know to skip would hide a later -C, --git-dir or --exec-path from this scan.
const FLAGS = new Set(["--no-pager", "--no-replace-objects", "--version"]);

/**
 * The directories a request works in: cwd, `--work-tree` and `--git-dir`. A value that is not a plain absolute path
 * (a relative `--git-dir=.git` would be read against cwd by git, never matching anything here) is refused.
 * Only git's OPTION area is read: from the start up to the subcommand (the first argument that does not start with `-`).
 * Every argument in it must be one of FLAGS, `--git-dir=<abs>`, `--work-tree=<abs>` or `-c <key=value>` (the value is
 * data, but an `alias.*` key is refused: an alias beginning with `!` runs a shell command). A pathspec such as `-Cache`
 * after the subcommand is data.
 */
export function requestDirs(req: GitRunRequest, platform: NodeJS.Platform = process.platform): string[] {
  const dirs = [req.cwd];
  for (let i = 0; i < req.argv.length; i++) {
    const a = req.argv[i] as string;
    if (!a.startsWith("-")) break;
    // git-ops builds only the `=` forms; the split forms and -C are never parsed here, so a caller may not carry them.
    if (a === "-C" || a === "--git-dir" || a === "--work-tree" || (a.startsWith("-C") && !a.startsWith("--"))) {
      throw denied("-C and the split --git-dir and --work-tree forms are not allowed; use --git-dir=<abs> and --work-tree=<abs>");
    }
    // --exec-path[=<dir>] makes git run its helpers (git-<name>) from <dir>, which may be inside the worktree.
    if (a === "--exec-path" || a.startsWith("--exec-path=")) throw denied("--exec-path is not allowed");
    if (a.startsWith("--work-tree=")) dirs.push(a.slice(12));
    else if (a.startsWith("--git-dir=")) dirs.push(a.slice(10));
    else if (a === "-c") {
      const kv = req.argv[++i];
      if (kv === undefined) throw denied("-c needs a key=value");
      if (/^alias\./i.test(kv)) throw denied("-c alias.* is not allowed: an alias can run a shell command");
    } else if (!FLAGS.has(a)) throw denied(`the git option ${a.split("=")[0]} is not allowed before the subcommand`);
  }
  if (!dirs.every((d) => isPlainAbsolute(d, platform))) throw denied("cwd, --work-tree and --git-dir must be absolute paths");
  return dirs;
}

// Variables that move git's helpers, config or repository. GIT_INDEX_FILE is NOT here: the bound commit sets it itself.
const ENV_OVERRIDE = /^GIT_(EXEC_PATH|CONFIG.*|DIR|WORK_TREE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|SHALLOW_FILE|TEMPLATE_DIR)$/i;

/** Refuses an environment that moves git's helpers, config or repository (GIT_EXEC_PATH, GIT_CONFIG*, GIT_DIR, the object, namespace, shallow and template variables). */
export function assertNoEnvOverride(env: Record<string, string>): void {
  if (Object.keys(env).some((n) => ENV_OVERRIDE.test(n))) throw denied("the environment must not set GIT_EXEC_PATH, GIT_CONFIG*, GIT_DIR, GIT_WORK_TREE, GIT_COMMON_DIR, GIT_OBJECT_DIRECTORY, GIT_ALTERNATE_OBJECT_DIRECTORIES, GIT_NAMESPACE, GIT_SHALLOW_FILE or GIT_TEMPLATE_DIR");
}

/**
 * Refuses a git executable that is not absolute or lies in the request's directories, by spelling or by real path
 * (symlinks resolved). `<worktree>/..bin/git` is inside: containment is judged by path component, not by a `..` prefix.
 */
export function assertGitOutsideWorktree(gitPath: string, req: GitRunRequest, platform: NodeJS.Platform): void {
  if (!isPlainAbsolute(gitPath, platform) || isInsideAny(gitPath, requestDirs(req, platform), platform, nodeFs)) {
    throw denied("the git executable must be an absolute path outside the worktree");
  }
}

/**
 * The request's environment with a PATH that holds only plain absolute entries outside the request's directories
 * (git's own children - helpers, hooks, external commands - resolve through it). Containment is judged by real path, as
 * for the executable itself, so a symlinked entry that leads into the worktree is dropped too.
 */
export function withTrustedPath(env: Record<string, string>, req: GitRunRequest, platform: NodeJS.Platform): Record<string, string> {
  const out = { ...env };
  const dirs = requestDirs(req, platform);
  for (const k of Object.keys(out)) {
    if (k !== "PATH" && !(platform === "win32" && k.toUpperCase() === "PATH")) continue;
    out[k] = (out[k] as string)
      .split(delimiterOf(platform))
      .filter((d) => isPlainAbsolute(d, platform) && !isInsideAny(d, dirs, platform, nodeFs))
      .join(delimiterOf(platform));
  }
  return out;
}
