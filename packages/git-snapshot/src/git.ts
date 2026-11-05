// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, parse, resolve } from "node:path";
import { buildGitEnv } from "@axis/pty-policy";
import { SnapshotError } from "./errors.js";
import { Exhausted, type Budget, type Limits } from "./limits.js";
import { isWithin, realish } from "./paths.js";

// A config that includes a FIFO makes git wait for ever; the call is cut and the snapshot fails closed.
const TIMEOUT_MS = 5000;

/** One setting as git reports it: raw bytes (as latin1 text), and the file it came from. */
export interface GitConfigEntry {
  /** `section.subsection.name`, section and name lower-case, as git prints it. */
  readonly key: string;
  /** Latin-1 view of the value's bytes; null for a bare key. */
  readonly value: string | null;
  /** The `file:` origin path (latin1), or null for another origin (command line, standard input, blob). */
  readonly file: string | null;
}

export interface GitView {
  /** What git finds from inside the worktree, as a terminal `git` would (no `--work-tree` or `--git-dir`). */
  readonly discovered: {
    readonly gitDir: string | null;
    readonly commonDir: string | null;
    /** `rev-parse --show-toplevel`: where hooks run and relative hook paths start. `core.worktree` moves it. */
    readonly topLevel: string | null;
  };
  /** `git config --list --show-origin -z` with includes followed; null when git could not read the config. */
  readonly config: readonly GitConfigEntry[] | null;
  /** `git rev-parse --git-path hooks`, resolved against git's top level; null when git could not say. */
  readonly hooksDir: string | null;
  /** Fixed-text reasons something could not be asked of git. */
  readonly problems: readonly string[];
}

const exe = (platform: NodeJS.Platform): readonly string[] => (platform === "win32" ? ["git.exe", "git.com"] : ["git"]);

/** The `PATH` entries that are safe to search: absolute only. An empty or relative entry means "the current directory". */
export function trustedPathEntries(pathValue: string | undefined, platform: NodeJS.Platform = process.platform): string[] {
  const sep = platform === "win32" ? ";" : delimiter;
  return (pathValue ?? "").split(sep).filter((e) => e.length > 0 && !e.includes("\0") && isAbsolute(e));
}

/**
 * The absolute path of `git`, looked up only in absolute `PATH` entries and never in a directory that holds a
 * worktree (`forbidden`, compared by real path). Returns null when there is none. Never a bare command name: the
 * worktree is writable by the CLI, and a `git` planted there must not run with the daemon's privileges (CLI-1, CFG-1).
 */
export async function resolveGit(
  pathValue: string | undefined,
  forbidden: readonly string[],
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  const bad = await Promise.all(forbidden.map((f) => realish(f)));
  for (const dir of trustedPathEntries(pathValue, platform)) {
    for (const name of exe(platform)) {
      const candidate = join(dir, name);
      try {
        if (!(await stat(candidate)).isFile()) continue;
        if (platform !== "win32") await access(candidate, constants.X_OK);
      } catch {
        continue;
      }
      const real = await realish(candidate);
      if (bad.some((b) => isWithin(b, real) || isWithin(b, resolve(candidate)))) continue;
      return candidate;
    }
  }
  return null;
}

interface Out {
  readonly ok: boolean;
  readonly stdout: Buffer;
}

const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";

/**
 * The environment for every call here: the GIT-ENV-1 allow-list from `@axis/pty-policy` (no caller `GIT_*`, no
 * prompts), `HOME` set to the user's home so git expands `~` as the pty process does, no system or user config (the
 * guard set covers the repository's own files), discovery that cannot climb above the worktree, and a `PATH` of
 * absolute entries only.
 */
export function snapshotGitEnv(parent: Readonly<Record<string, string | undefined>>, home: string, worktree: string): Record<string, string> {
  const env = { ...buildGitEnv(parent).env };
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH");
  if (pathKey !== undefined) env[pathKey] = trustedPathEntries(env[pathKey]).join(process.platform === "win32" ? ";" : delimiter);
  env["HOME"] = home;
  env["GIT_CONFIG_NOSYSTEM"] = "1";
  env["GIT_CONFIG_GLOBAL"] = nullDevice;
  env["GIT_CEILING_DIRECTORIES"] = dirname(worktree);
  return env;
}

const utf8 = (b: Buffer): string | null => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(b);
  } catch {
    return null;
  }
};

/** One output line without its newline; null for empty output, more than one line, or bytes that are not UTF-8. */
function oneLine(b: Buffer): string | null {
  const s = utf8(b);
  if (s === null || !s.endsWith("\n")) return null;
  const line = s.slice(0, -1);
  return line.length === 0 || line.includes("\n") || line.includes("\0") ? null : line;
}

/**
 * Parses `git config --list --show-origin -z`: `origin NUL key [LF value] NUL` records. At most `maxEntries`:
 * more is `null` (the caller treats that as "could not read"), found by scanning, with no array of all the pieces.
 */
export function parseListOutput(out: Buffer, maxEntries = Number.MAX_SAFE_INTEGER): GitConfigEntry[] | null {
  const entries: GitConfigEntry[] = [];
  let pos = 0;
  const take = (): string | null => {
    const nul = out.indexOf(0, pos);
    if (nul < 0) return null;
    const s = out.toString("latin1", pos, nul);
    pos = nul + 1;
    return s;
  };
  while (pos < out.length) {
    const origin = take();
    const rec = origin === null ? null : take();
    if (origin === null || rec === null || entries.length >= maxEntries) return null;
    const nl = rec.indexOf("\n");
    entries.push({
      key: nl < 0 ? rec : rec.slice(0, nl),
      value: nl < 0 ? null : rec.slice(nl + 1),
      file: origin.startsWith("file:") ? origin.slice(5) : null,
    });
  }
  return entries;
}

export interface AskInput {
  readonly worktree: string;
  /** The journal's git dir for the worktree, when the caller has one. */
  readonly gitDir: string | null;
  readonly commonDir: string;
  readonly home: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Absolute path of git, resolved outside every worktree. */
  readonly gitPath: string;
  readonly budget: Budget;
  readonly limits: Limits;
}

/**
 * Asks git, with the hardened environment, for what the parser only second-guesses: where the worktree's git dirs and
 * top level are (discovery, as a terminal would), every config entry with its origin (includes followed by git), and
 * the hook directory git will use. Every call is `rev-parse` or `config --list`, which run no hook and no program
 * named in config, from an absolute `git`, with a neutral working directory and `-C <worktree>`. `safe.directory` is
 * set for these read-only calls so a repository git calls "dubious ownership" is still read; nothing here can run
 * code from it.
 */
export async function askGit(i: AskInput): Promise<GitView> {
  const env = snapshotGitEnv(i.env, i.home, i.worktree);
  const problems: string[] = [];
  const cwd = parse(i.worktree).root;
  const safe = [i.worktree, i.commonDir, ...(i.gitDir === null ? [] : [i.gitDir])].flatMap((d) => ["-c", `safe.directory=${d}`]);
  const base = ["-C", i.worktree, "--no-pager", "--no-replace-objects", "-c", "core.fsmonitor=false", ...safe];
  const maxBuffer = Math.max(1024 * 1024, i.limits.maxConfigBytes * 2);
  const run = (argv: readonly string[]): Promise<Out> => {
    i.budget.tick();
    return new Promise((done) => {
      const timeout = Math.max(1, Math.floor(Math.min(TIMEOUT_MS, i.budget.remaining())));
      const opts = { cwd, env, encoding: "buffer" as const, maxBuffer, timeout, windowsHide: true, ...(i.budget.signal === undefined ? {} : { signal: i.budget.signal }) };
      execFile(i.gitPath, [...base, ...argv], opts, (err, stdout) => done({ ok: err === null, stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.alloc(0) }));
    });
  };
  const guard = async (argv: readonly string[]): Promise<Out> => {
    try {
      return await run(argv);
    } catch (e) {
      if (e instanceof SnapshotError || e instanceof Exhausted) throw e;
      return { ok: false, stdout: Buffer.alloc(0) };
    }
  };
  const line = async (argv: readonly string[]): Promise<string | null> => {
    const o = await guard(argv);
    return o.ok ? oneLine(o.stdout) : null;
  };
  const gd = await line(["rev-parse", "--absolute-git-dir"]);
  const cd = await line(["rev-parse", "--git-common-dir"]);
  const top = await line(["rev-parse", "--show-toplevel"]);
  if (gd === null || cd === null || top === null) problems.push("git could not find the repository from the worktree");
  const discovered = {
    gitDir: gd === null ? null : resolve(i.worktree, gd),
    commonDir: cd === null ? null : resolve(i.worktree, cd),
    topLevel: top === null ? null : resolve(i.worktree, top),
  };
  const useDir = i.gitDir ?? discovered.gitDir;
  let config: GitConfigEntry[] | null = null;
  let hooksDir: string | null = null;
  if (useDir === null) {
    problems.push("no git directory to ask about");
  } else {
    const dir = [`--git-dir=${useDir}`];
    const list = await guard([...dir, "config", "--list", "--show-origin", "-z", "--includes"]);
    config = list.ok ? parseListOutput(list.stdout, i.limits.maxSettings * 8) : null;
    if (config === null) problems.push("git could not read the configuration");
    // No `--work-tree`: git then uses its own top level, so a relative hooks path starts where git runs hooks.
    const hp = await line([...dir, "rev-parse", "--git-path", "hooks"]);
    if (hp === null) problems.push("git could not name the hooks directory");
    else hooksDir = resolve(discovered.topLevel ?? i.worktree, hp);
  }
  return { discovered, config, hooksDir, problems };
}
