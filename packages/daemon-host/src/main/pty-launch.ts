// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// PV-X1b (docs/design/pty-exec-node.md §6.1 and §6.2): what main gives the pty process at fork.
// - Programs: `git` and `gh`, resolved ONCE at start by the trusted resolver (`@axis/pty-policy` `resolveExecutable`) over main's
//   resolved shell environment, outside the Axis data and worktree roots, then made real paths. A program the pty entry would
//   refuse is left out (that consumer is off) rather than refusing the whole process.
// - Scratch: `<base>/pty-scratch/run-*`, one per spawn, mode 0700, removed when that process exits; leftovers of an earlier run
//   (main or the pty process crashed) are removed at start, so nothing accumulates.
// - Environment (PTY-5): only the daemon's allow-listed names plus `SSH_AUTH_SOCK` (git over ssh), then the three hand-over names.
//   Nothing else of main's environment: no `AXIS_*` of another component, no vault or provider key, no `NODE_OPTIONS`.
// - The whole hand-over is checked with the entry's own `readPtyExecConfig` before the fork, so a wrong resolution is a closed code
//   in main's log, not the pty process's exit 78.
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { nodeFs, resolveExecutable, type ExecFs } from "@axis/pty-policy";
import { PTY_ENV_GH, PTY_ENV_GIT, PTY_ENV_SCRATCH, readPtyExecConfig } from "@axis/pty-process/config";
import { daemonEnvironment } from "../supervisor.js";

type Env = Readonly<Record<string, string | undefined>>;

export interface PtyPrograms {
  readonly gitPath?: string;
  readonly ghPath?: string;
}

/** Names besides the daemon's allow-list the pty process needs: git pushes over ssh use the agent socket. */
export const PTY_ENV_EXTRA = Object.freeze(["SSH_AUTH_SOCK"] as const);
export const PTY_SCRATCH_DIR = "pty-scratch";
const RUN_PREFIX = "run-";

export type PtyLaunchEvent = "git_path_refused" | "gh_path_refused" | "scratch_refused" | "git_missing" | "gh_missing";

/**
 * `git` and `gh` by the trusted resolver, as real paths. Not found, or the real path cannot be read: left out. Windows: none (the
 * pty process has no exec there, PV-X1w).
 */
export function resolvePtyPrograms(env: Env, platform: NodeJS.Platform, excludeDirs: readonly string[], fs: ExecFs = nodeFs): PtyPrograms {
  if (platform === "win32") return {};
  const find = (name: string): string | undefined => {
    const found = resolveExecutable(name, env, platform, fs, { excludeDirs });
    return found === undefined ? undefined : fs.realPath?.(found);
  };
  const gitPath = find("git");
  const ghPath = find("gh");
  return { ...(gitPath === undefined ? {} : { gitPath }), ...(ghPath === undefined ? {} : { ghPath }) };
}

/** The pty process's environment: the allow-listed names of `source`, `SSH_AUTH_SOCK`, then the given hand-over names only. */
export function ptyEnvironment(source: Env, handover: { readonly gitPath?: string; readonly ghPath?: string; readonly scratch?: string }): Record<string, string> {
  const env = daemonEnvironment(source);
  for (const name of PTY_ENV_EXTRA) {
    const value = source[name];
    if (typeof value === "string") env[name] = value;
  }
  if (handover.gitPath !== undefined) env[PTY_ENV_GIT] = handover.gitPath;
  if (handover.ghPath !== undefined) env[PTY_ENV_GH] = handover.ghPath;
  if (handover.scratch !== undefined) env[PTY_ENV_SCRATCH] = handover.scratch;
  return env;
}

/** `<base>/pty-scratch`, next to (never inside) the daemon's data directory. */
export function ptyScratchRoot(dataDir: string): string {
  return join(dirname(dataDir), PTY_SCRATCH_DIR);
}

/**
 * Makes the scratch root (mode 0700, this user's, not a symlink) and removes every leftover in it. False when it cannot be made
 * safe: git is then off for this start.
 */
export function preparePtyScratchRoot(root: string): boolean {
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const st = lstatSync(root);
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (!st.isDirectory() || (uid !== undefined && st.uid !== uid)) return false;
    if ((st.mode & 0o777) !== 0o700) chmodSync(root, 0o700);
    for (const name of readdirSync(root)) rmSync(join(root, name), { recursive: true, force: true });
    return (lstatSync(root).mode & 0o077) === 0;
  } catch {
    return false;
  }
}

/** One run's scratch directory (mode 0700) inside `root`, or undefined. */
export function newPtyScratch(root: string): string | undefined {
  try {
    const dir = mkdtempSync(join(root, RUN_PREFIX));
    chmodSync(dir, 0o700);
    return dir;
  } catch {
    return undefined;
  }
}

/** Removes a run's scratch directory; only a direct `run-*` child of `root` is ever removed. */
export function removePtyScratch(dir: string, root: string): void {
  if (dirname(dir) !== root || !dir.slice(root.length + 1).startsWith(RUN_PREFIX)) return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // swept at the next start
  }
}

/**
 * The hand-over for one spawn, checked with the entry's own rule. A refused program is dropped (with its closed code) and the
 * check repeated, so the result is always one the entry accepts; a refused scratch turns git off.
 */
export function checkedHandover(programs: PtyPrograms, scratch: string | undefined, onEvent?: (event: PtyLaunchEvent) => void): { gitPath?: string; ghPath?: string; scratch?: string } {
  let h: { gitPath?: string; ghPath?: string; scratch?: string } = { ...programs, ...(programs.gitPath !== undefined && scratch !== undefined ? { scratch } : {}) };
  if (programs.gitPath !== undefined && scratch === undefined) {
    onEvent?.("scratch_refused");
    h = { ...(h.ghPath === undefined ? {} : { ghPath: h.ghPath }) };
  }
  for (let i = 0; i < 3; i++) {
    const verdict = readPtyExecConfig(ptyEnvironment({}, h));
    if (typeof verdict !== "string") return h;
    onEvent?.(verdict as PtyLaunchEvent);
    if (verdict === "git_path_refused" || verdict === "scratch_refused") h = { ...(h.ghPath === undefined ? {} : { ghPath: h.ghPath }) };
    else if (verdict === "gh_path_refused") h = { ...(h.gitPath === undefined ? {} : { gitPath: h.gitPath, ...(h.scratch === undefined ? {} : { scratch: h.scratch }) }) };
    else return {};
  }
  return {};
}

/** The process handle `createPtySpawn` returns: the supervisor's `PtyChild`, with the scratch removed after the exit. */
export interface PtyForkedChild {
  kill(signal: "SIGTERM" | "SIGKILL"): unknown;
  onExit(handler: (code: number | null) => void): () => void;
  postMessage(message: unknown, transfer?: readonly unknown[]): void;
}

export interface PtySpawnOptions {
  readonly platform: NodeJS.Platform;
  /** Main's resolved shell environment. */
  readonly shellEnv: Env;
  readonly programs: PtyPrograms;
  /** The prepared scratch root, or undefined (git off). */
  readonly scratchRoot: string | undefined;
  /** Forks the FIXED entry with exactly this environment. */
  readonly fork: (env: Record<string, string>) => PtyForkedChild;
  readonly onEvent?: (event: PtyLaunchEvent) => void;
}

/** The supervisor's `spawn`: a fresh scratch and a checked hand-over per process, the scratch removed when that process exits. */
export function createPtySpawn(o: PtySpawnOptions): () => PtyForkedChild {
  return () => {
    const root = o.scratchRoot;
    const scratch = o.platform === "win32" || root === undefined || o.programs.gitPath === undefined ? undefined : newPtyScratch(root);
    const handover = o.platform === "win32" ? {} : checkedHandover(o.programs, scratch, o.onEvent);
    let child: PtyForkedChild;
    try {
      child = o.fork(ptyEnvironment(o.shellEnv, handover));
    } catch (e) {
      if (scratch !== undefined && root !== undefined) removePtyScratch(scratch, root);
      throw e;
    }
    if (scratch !== undefined && root !== undefined && handover.scratch === undefined) removePtyScratch(scratch, root);
    if (scratch === undefined || root === undefined || handover.scratch === undefined) return child;
    return {
      kill: (signal) => child.kill(signal),
      postMessage: (message, transfer) => child.postMessage(message, transfer),
      onExit: (handler) => child.onExit((code) => {
        removePtyScratch(scratch, root);
        handler(code);
      }),
    };
  };
}
