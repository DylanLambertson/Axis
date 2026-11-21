// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// GIT-7 argument hygiene and the hardened prefix for every git call.
import { readdirSync } from "node:fs";
import { isAbsolute as posixAbs, normalize as posixNorm } from "node:path/posix";
import { isAbsolute as winAbs, normalize as winNorm } from "node:path/win32";
import { refNameSchema } from "@axis/protocol";
import { daemonGitEnv } from "./env.js";
import { GitOpsError, denied, invalid } from "./errors.js";
import type { GitContext, GitOpsDeps, GitRunRequest, GitRunResult, GitRunner, WorktreeRef } from "./types.js";

export const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
export const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
export const EMPTY_TREE_SHA1 = "4b825dc642cb58ee0a9a8e1fc7e1dc5e0cbab52f";

export function platformOf(deps: Pick<GitOpsDeps, "platform">): NodeJS.Platform {
  return deps.platform ?? process.platform;
}

/** A ref typed by a user or derived from one: protocol's refNameSchema, no leading '-'. */
export function safeRef(value: unknown, what: string): string {
  if (typeof value !== "string" || value.startsWith("-") || !refNameSchema.safeParse(value).success) {
    throw invalid(`${what} is not a valid ref name`);
  }
  return value;
}

export function branchFor(value: unknown): { branch: string; slug: string } {
  const branch = safeRef(value, "branch");
  const m = /^axis\/(.+)$/.exec(branch);
  if (!m || !SLUG.test(m[1] as string)) throw denied("only branches named axis/<slug> can be committed to or pushed");
  return { branch, slug: m[1] as string };
}

export function checkWorktree(w: WorktreeRef, platform: NodeJS.Platform): void {
  for (const [what, p] of [["work tree", w.workTree], ["git directory", w.gitDir]] as const) {
    if (typeof p !== "string" || p.length === 0 || p.includes("\0")) throw invalid(`the ${what} must be a normalised absolute path`);
    const abs = platform === "win32" ? winAbs(p) : posixAbs(p);
    const norm = platform === "win32" ? winNorm(p) : posixNorm(p);
    const trim = (s: string): string => s.replace(/[\\/]+$/, "");
    if (!abs || trim(norm) !== trim(p)) throw invalid(`the ${what} must be a normalised absolute path`);
  }
}

/** The path git sees as an empty hooks directory. POSIX: /dev/null (hooks then fail with ENOTDIR and are skipped). */
export function hooksOffPath(deps: GitOpsDeps): string {
  if (platformOf(deps) !== "win32") return "/dev/null";
  const dir = deps.emptyHooksDir;
  if (!dir) throw denied("hooks cannot be disabled on Windows without an empty hooks directory");
  if (readdirSync(dir).length !== 0) throw denied("the empty hooks directory is not empty");
  return dir;
}

export interface PrefixOptions {
  readonly context: GitContext;
  /** Pty context only: leave repository hooks enabled (axis.git.runHooks). */
  readonly hooks: boolean;
  /** Filter names present in the effective config; neutralised on the daemon side. */
  readonly filters: readonly string[];
}

/** Global options placed before the subcommand. Explicit --git-dir/--work-tree come from the journal (GIT-4). */
export function prefix(w: WorktreeRef, deps: GitOpsDeps, o: PrefixOptions): string[] {
  // refs/replace is writable by the code running in the worktree but pack-objects ignores it, so reads that decide what is pushed must ignore it too.
  const a = ["--no-pager", "--no-replace-objects", `--git-dir=${w.gitDir}`, `--work-tree=${w.workTree}`, "-c", "core.fsmonitor=false", "-c", "protocol.ext.allow=never"];
  // The daemon never touches the network or a remote. `protocol.allow=never` alone does NOT stop a lazy fetch in a partial
  // clone: a repository `protocol.<name>.allow=always` overrides it (only `ext` is pinned by name above), and the repository
  // then chooses what runs (uploadpack, core.sshCommand, a `vcs` helper or alias). The daemon environment closes that:
  // GIT_NO_LAZY_FETCH=1 (git 2.44+) and GIT_ALLOW_PROTOCOL=/ (every git since 2.12, `daemonGitEnv`), with
  // help.autocorrect=0 below for the `/` helper name.
  if (o.context === "daemon") a.push("-c", "protocol.allow=never");
  const hooksOn = o.context === "pty" && o.hooks;
  if (!hooksOn) a.push("-c", `core.hooksPath=${hooksOffPath(deps)}`);
  if (o.context === "daemon") {
    // diff.submodule=diff would make git spawn a child `git diff` in a nested repository that ignores --no-ext-diff.
    a.push("-c", "commit.gpgsign=false", "-c", "core.askPass=", "-c", "diff.submodule=short");
    // GIT_ALLOW_PROTOCOL=/ admits a helper named `/` (remote.<r>.vcs=/); `git remote-/` does not exist, and with
    // help.autocorrect set git would run the closest alias (alias.remote-a) instead. `0` suggests only, on every version.
    a.push("-c", "help.autocorrect=0");
    for (const f of o.filters) {
      for (const k of ["clean", "smudge", "process"]) a.push("-c", `filter.${f}.${k}=`);
      a.push("-c", `filter.${f}.required=false`);
    }
  }
  return a;
}

/** The global options before the subcommand: bare flags, `-c key=value` pairs, and where they end. */
function leadingOptions(argv: readonly string[]): { flags: Set<string>; configs: Set<string> } {
  const flags = new Set<string>();
  const configs = new Set<string>();
  for (let i = 0; i < argv.length && (argv[i] as string).startsWith("-"); i++) {
    if (argv[i] === "-c") configs.add(argv[++i] ?? "");
    else flags.add(argv[i] as string);
  }
  return { flags, configs };
}

/**
 * Wraps a runner so a daemon-context call that lacks the hardened prefix is refused. Every protection that `prefix()`
 * adds for the daemon must be present among the options before the subcommand; a pair placed after the subcommand
 * (where git reads it as an argument, not an option) does not count.
 */
export function guardedRunner(inner: GitRunner, deps: GitOpsDeps): GitRunner {
  return {
    async run(req: GitRunRequest): Promise<GitRunResult> {
      if (req.context === "daemon") {
        const { flags, configs } = leadingOptions(req.argv);
        const off = hooksOffPath(deps);
        const missing = [
          ...["--no-pager", "--no-replace-objects"].filter((f) => !flags.has(f)),
          ...["--git-dir=", "--work-tree="].filter((p) => ![...flags].some((f) => f.startsWith(p) && f.length > p.length)),
          ...[`core.hooksPath=${off}`, "core.fsmonitor=false", "protocol.allow=never", "protocol.ext.allow=never", "commit.gpgsign=false", "core.askPass=", "diff.submodule=short", "help.autocorrect=0"].filter((c) => !configs.has(c)),
        ];
        if (off === "" || missing.length > 0) {
          throw denied(`a daemon-side git call must carry the hardened options (missing: ${missing.join(", ") || "core.hooksPath"})`);
        }
      }
      return inner.run(req);
    },
  };
}

/** Reads filter.* names from the effective config so the daemon side can neutralise every driver. */
export async function filterNames(w: WorktreeRef, deps: GitOpsDeps, env: Record<string, string>): Promise<string[]> {
  const r = await guardedRunner(deps.runner, deps).run({
    argv: [...prefix(w, deps, { context: "daemon", hooks: false, filters: [] }), "config", "--null", "--name-only", "--get-regexp", "^filter\\."],
    cwd: w.workTree,
    env,
    context: "daemon",
  });
  if (r.code === 1) return [];
  if (r.code !== 0) throw invalid("could not read the git configuration");
  const names = new Set<string>();
  for (const key of r.stdout.split("\0").filter(Boolean)) {
    // The name may be empty: `[filter ""]` is the driver `* filter=` selects, and `-c filter..clean=` empties it. `s`, so a
    // name holding a line terminator (U+2028, U+0085, CR) is read like any other and then refused below. git prints the
    // section and the variable lower-cased, so the match needs no `i`.
    const m = /^filter\.(.*)\.(clean|smudge|process|required)$/s.exec(key);
    if (m === null) {
      // Only a two-level key such as `filter.process` names no driver (git ignores it). Any other key is refused, never
      // skipped: a key this cannot read could be a driver it did not empty.
      if (/^filter\.[a-z0-9-]*$/.test(key)) continue;
      throw denied("a git filter key cannot be read safely");
    }
    const n = m[1] as string;
    if (!/^[A-Za-z0-9._-]*$/.test(n)) throw denied("a git filter has a name that cannot be neutralised safely");
    names.add(n);
  }
  return [...names];
}

/** `--end-of-options`, which every ref-taking call here relies on, first appeared in git 2.24. */
export const MIN_GIT_VERSION = { major: 2, minor: 24 } as const;

const versionChecked = new WeakSet<GitRunner>();

/**
 * Refuses (E_UNAVAILABLE) a git older than 2.24 or whose `git --version` output cannot be parsed.
 * A success is remembered per runner, so the check costs one process per runner, not one per call.
 */
export async function requireGitVersion(deps: GitOpsDeps, w: WorktreeRef, env: Record<string, string>): Promise<void> {
  if (versionChecked.has(deps.runner)) return;
  // Same hardened prefix as every other daemon call, so the hooks-off invariant has no exception.
  const argv = [...prefix(w, deps, { context: "daemon", hooks: false, filters: [] }), "--version"];
  const r = await guardedRunner(deps.runner, deps).run({ argv, cwd: w.workTree, env, context: "daemon" });
  const m = r.code === 0 ? /^git version (\d+)\.(\d+)(?![\d])/.exec(r.stdout.trim()) : null;
  if (!m) throw new GitOpsError("E_UNAVAILABLE", "could not determine the git version");
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (major < MIN_GIT_VERSION.major || (major === MIN_GIT_VERSION.major && minor < MIN_GIT_VERSION.minor)) {
    throw new GitOpsError("E_UNAVAILABLE", `git ${MIN_GIT_VERSION.major}.${MIN_GIT_VERSION.minor} or newer is required (found ${major}.${minor})`);
  }
  versionChecked.add(deps.runner);
}

export interface DaemonGit {
  (sub: readonly string[], stdin?: string, opts?: { readonly raw?: boolean }): Promise<GitRunResult>;
}

/** The only variable a caller may add to the daemon environment: a private index for a tree that is built off to the side. */
const EXTRA_ENV = new Set(["GIT_INDEX_FILE"]);

/**
 * A daemon-side git caller bound to a worktree: hardened prefix, filters neutralised, GIT-ENV-1 environment.
 * `extraEnv` may hold only `GIT_INDEX_FILE` (an absolute path without NUL); every other name is refused, so a caller
 * cannot use it to redirect the repository, the objects or the config.
 */
export async function daemonGitFor(
  w: WorktreeRef,
  deps: GitOpsDeps,
  extraEnv: Readonly<Record<string, string>> = {},
  /** Axis-built additions only (never caller input): more `-c key=value` pins and fixed variables such as GIT_ATTR_NOSYSTEM. */
  fixed: { readonly config?: readonly string[]; readonly env?: Readonly<Record<string, string>> } = {},
): Promise<DaemonGit> {
  const platform = platformOf(deps);
  for (const [k, v] of Object.entries(extraEnv)) {
    const abs = typeof v === "string" && (platform === "win32" ? winAbs(v) : posixAbs(v));
    if (!EXTRA_ENV.has(k) || !abs || (v as string).includes("\0")) throw invalid(`the daemon git environment cannot be extended with ${k}`);
  }
  const env = { ...daemonEnv(deps), ...extraEnv, ...fixed.env };
  await requireGitVersion(deps, w, env);
  const filters = await filterNames(w, deps, env);
  const runner = guardedRunner(deps.runner, deps);
  return (sub, stdin, opts) =>
    runner.run({
      argv: [...prefix(w, deps, { context: "daemon", hooks: false, filters }), ...(fixed.config ?? []).flatMap((c) => ["-c", c]), ...sub],
      cwd: w.workTree,
      env,
      context: "daemon",
      ...(stdin === undefined ? {} : { stdin }),
      ...(opts?.raw === true ? { raw: true } : {}),
    });
}

function daemonEnv(deps: GitOpsDeps): Record<string, string> {
  // No refusal for GIT_* here: the allow-list below already strips every one of them from the daemon's environment.
  return daemonGitEnv(deps.env.daemon, platformOf(deps));
}
