// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// GIT-7 argument hygiene and the hardened prefix for every git call.
import { readdirSync } from "node:fs";
import { isAbsolute as posixAbs, normalize as posixNorm } from "node:path/posix";
import { isAbsolute as winAbs, normalize as winNorm } from "node:path/win32";
import { refNameSchema } from "@axis/protocol";
import { daemonGitEnv, findOverride } from "./env.js";
import { denied, invalid } from "./errors.js";
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
  const a = ["--no-pager", `--git-dir=${w.gitDir}`, `--work-tree=${w.workTree}`, "-c", "core.fsmonitor=false", "-c", "protocol.ext.allow=never"];
  const hooksOn = o.context === "pty" && o.hooks;
  if (!hooksOn) a.push("-c", `core.hooksPath=${hooksOffPath(deps)}`);
  if (o.context === "daemon") {
    a.push("-c", "commit.gpgsign=false", "-c", "core.askPass=");
    for (const f of o.filters) {
      for (const k of ["clean", "smudge", "process"]) a.push("-c", `filter.${f}.${k}=`);
      a.push("-c", `filter.${f}.required=false`);
    }
  }
  return a;
}

/** Wraps a runner so a daemon-context call without the hooks-off prefix is refused. */
export function guardedRunner(inner: GitRunner, deps: GitOpsDeps): GitRunner {
  return {
    async run(req: GitRunRequest): Promise<GitRunResult> {
      if (req.context === "daemon") {
        const off = `core.hooksPath=${platformOf(deps) === "win32" ? (deps.emptyHooksDir ?? "") : "/dev/null"}`;
        const i = req.argv.indexOf(off);
        if (i < 1 || req.argv[i - 1] !== "-c") throw denied("a daemon-side git call must carry an empty core.hooksPath");
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
    const m = /^filter\.(.+)\.(clean|smudge|process|required)$/i.exec(key);
    if (!m) continue;
    const n = m[1] as string;
    if (!/^[A-Za-z0-9._-]+$/.test(n)) throw denied("a git filter has a name that cannot be neutralised safely");
    names.add(n);
  }
  return [...names];
}

export interface DaemonGit {
  (sub: readonly string[], stdin?: string): Promise<GitRunResult>;
}

/** A daemon-side git caller bound to a worktree: hardened prefix, filters neutralised, GIT-ENV-1 environment. */
export async function daemonGitFor(w: WorktreeRef, deps: GitOpsDeps): Promise<DaemonGit> {
  const env = daemonEnv(deps);
  const filters = await filterNames(w, deps, env);
  const runner = guardedRunner(deps.runner, deps);
  return (sub, stdin) =>
    runner.run({
      argv: [...prefix(w, deps, { context: "daemon", hooks: false, filters }), ...sub],
      cwd: w.workTree,
      env,
      context: "daemon",
      ...(stdin === undefined ? {} : { stdin }),
    });
}

function daemonEnv(deps: GitOpsDeps): Record<string, string> {
  const bad = findOverride(deps.env.daemon);
  if (bad) throw denied(`the daemon git environment must not set ${bad}`);
  return daemonGitEnv(deps.env.daemon, platformOf(deps));
}
