// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { daemonGitEnv } from "@axis/git-ops";
import { SnapshotError } from "./errors.js";
import { Exhausted, type Budget } from "./limits.js";

const MAX_OUTPUT = 32 * 1024 * 1024;
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
  /** What git finds from inside the worktree, as a terminal `git` would. */
  readonly discovered: { readonly gitDir: string | null; readonly commonDir: string | null };
  /** `git config --list --show-origin -z` with includes followed; null when git could not read the config. */
  readonly config: readonly GitConfigEntry[] | null;
  /** `git rev-parse --git-path hooks`, resolved against the worktree; null when git could not say. */
  readonly hooksDir: string | null;
  /** Fixed-text reasons something could not be asked of git. */
  readonly problems: readonly string[];
}

interface Out {
  readonly ok: boolean;
  readonly stdout: Buffer;
}

function run(argv: readonly string[], cwd: string, env: Record<string, string>, budget: Budget): Promise<Out> {
  budget.tick();
  return new Promise((done) => {
    execFile(
      "git",
      [...argv],
      { cwd, env, encoding: "buffer", maxBuffer: MAX_OUTPUT, timeout: TIMEOUT_MS, windowsHide: true },
      (err, stdout) => done({ ok: err === null, stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.alloc(0) }),
    );
  });
}

const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";

/**
 * The environment for every call here: the GIT-ENV-1 allow-list from `@axis/git-ops` (no `GIT_*` from the caller,
 * no prompts), `HOME` set to the user's home so git expands `~` as the pty process does, no system or user config
 * (the guard set covers the repository's own files), and discovery that cannot climb above the worktree.
 */
export function snapshotGitEnv(parent: Readonly<Record<string, string | undefined>>, home: string, worktree: string): Record<string, string> {
  const env = daemonGitEnv(parent);
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

/** Parses `git config --list --show-origin -z`: `origin NUL key [LF value] NUL` records. */
export function parseListOutput(out: Buffer): GitConfigEntry[] | null {
  const text = out.toString("latin1");
  const parts = text.split("\0");
  if (parts.pop() !== "") return null;
  if (parts.length % 2 !== 0) return null;
  const entries: GitConfigEntry[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const origin = parts[i] as string;
    const rec = parts[i + 1] as string;
    const nl = rec.indexOf("\n");
    entries.push({
      key: nl < 0 ? rec : rec.slice(0, nl),
      value: nl < 0 ? null : rec.slice(nl + 1),
      file: origin.startsWith("file:") ? origin.slice(5) : null,
    });
  }
  return entries;
}

/**
 * Asks git, with the hardened environment, for what the parser below only second-guesses: where the worktree's git
 * dirs are (discovery, as a terminal would), every config entry with its origin (includes followed by git), and
 * the hook directory git will use. `gitDir` is the journal's value when the caller has one. No call here runs a
 * hook or a program named in config: they are `config --list` and `rev-parse`.
 */
export async function askGit(
  worktree: string,
  gitDir: string | null,
  home: string,
  parentEnv: Readonly<Record<string, string | undefined>>,
  budget: Budget,
): Promise<GitView> {
  const env = snapshotGitEnv(parentEnv, home, worktree);
  const problems: string[] = [];
  const base = ["--no-pager", "--no-replace-objects", "-c", "core.fsmonitor=false"];
  const ask = async (argv: readonly string[]): Promise<Out> => {
    try {
      return await run([...base, ...argv], worktree, env, budget);
    } catch (e) {
      if (e instanceof SnapshotError || e instanceof Exhausted) throw e;
      return { ok: false, stdout: Buffer.alloc(0) };
    }
  };
  const gd = await ask(["rev-parse", "--absolute-git-dir"]);
  const cd = await ask(["rev-parse", "--git-common-dir"]);
  const gitDirOut = gd.ok ? oneLine(gd.stdout) : null;
  const commonOut = cd.ok ? oneLine(cd.stdout) : null;
  if (gitDirOut === null || commonOut === null) problems.push("git could not find the repository from the worktree");
  const discovered = {
    gitDir: gitDirOut === null ? null : resolve(worktree, gitDirOut),
    commonDir: commonOut === null ? null : resolve(worktree, commonOut),
  };
  const useDir = gitDir ?? discovered.gitDir;
  let config: GitConfigEntry[] | null = null;
  let hooksDir: string | null = null;
  if (useDir !== null) {
    const pre = [`--git-dir=${useDir}`, `--work-tree=${worktree}`];
    const list = await run(["--no-pager", "--no-replace-objects", ...pre, "config", "--list", "--show-origin", "-z", "--includes"], worktree, env, budget);
    config = list.ok ? parseListOutput(list.stdout) : null;
    if (config === null) problems.push("git could not read the configuration");
    const hp = await ask([...pre, "rev-parse", "--git-path", "hooks"]);
    const line = hp.ok ? oneLine(hp.stdout) : null;
    if (line === null) problems.push("git could not name the hooks directory");
    else hooksDir = resolve(worktree, line);
  } else {
    problems.push("no git directory to ask about");
  }
  return { discovered, config, hooksDir, problems };
}
