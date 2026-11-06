// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPtyService, parseGitVersion, type ExecFn, type ExecRequest, type GitVersion, type PtyService, type SpawnRequest } from "../src/index.js";
import { findGit, pipeExec } from "./exec.js";
import { channelPair, pipeSpawn, until, type ChannelPair } from "./helpers.js";

/** TEST ONLY. The repository's own git (absolute), its version, and why git tests must skip here (false when they can run). */
export const GIT = findGit();
export const GIT_VERSION: GitVersion | undefined = GIT === undefined ? undefined : parseGitVersion(execFileSync(GIT, ["version"], { encoding: "utf8" }));
export const SKIP: string | false =
  process.platform === "win32" ? "POSIX process groups and modes are needed (the Windows path is unverified)" : GIT === undefined ? "no git on PATH" : GIT_VERSION === undefined ? "git version unreadable" : false;
export const atLeastGit = (want: GitVersion): boolean => {
  const v = GIT_VERSION;
  return v !== undefined && (v[0] !== want[0] ? v[0] > want[0] : v[1] !== want[1] ? v[1] > want[1] : v[2] >= want[2]);
};

type Reply = { t: string; req?: string; term?: string; [k: string]: unknown };

export interface GitRig {
  readonly tmp: string;
  readonly scratchParent: string;
  readonly home: string;
  /** The user's global config file the service's startup environment names. */
  readonly globalConfig: string;
  readonly service: PtyService;
  readonly pair: ChannelPair;
  readonly execLog: ExecRequest[];
  readonly spawned: SpawnRequest[];
  readonly baseEnv: Record<string, string>;
  /** Sends a control message and waits for the reply with the same `req`. */
  send(msg: Record<string, unknown>): Promise<Reply>;
  /** Waits for the `exit` of a terminal. */
  exit(term: string): Promise<Reply>;
  /** Plain git for building fixtures, with the rig's HOME and global config and a fixed identity. */
  git(args: readonly string[], cwd: string, input?: string | Uint8Array, extraEnv?: Record<string, string>): string;
  /** A new repository with one commit (`a.txt`); returns its top level and git directory. */
  repo(name: string): { top: string; gitDir: string };
  /** A marker program that appends `name` to the marker log. */
  marker(name: string, tail?: string): string;
  /** The marker directory, first on the service's PATH. */
  readonly bin: string;
  markers(): string;
  cleanup(): void;
}

let counter = 0;

/** TEST ONLY: a pty service with a real exec function and pipe-spawned terminals, over an in-memory control channel. */
export function gitRig(opts: { exec?: ExecFn; maxExecs?: number; gitPath?: string } = {}): GitRig {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "axis-pty-git-")));
  const scratchParent = join(tmp, "scratch");
  const home = join(tmp, "home");
  const bin = join(tmp, "bin");
  for (const d of [scratchParent, home, bin]) mkdirSync(d, { mode: 0o700 });
  const globalConfig = join(home, ".gitconfig");
  writeFileSync(globalConfig, "");
  const markerLog = join(tmp, "markers.log");
  writeFileSync(markerLog, "");
  // The marker directory leads PATH, so a test can plant a program git would look up there (a `git-remote-<x>` helper).
  const baseEnv: Record<string, string> = { PATH: `${bin}:${process.env["PATH"] ?? "/usr/bin:/bin"}`, HOME: home, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: "1", LANG: "C" };
  const execLog: ExecRequest[] = [];
  const spawned: SpawnRequest[] = [];
  const pair = channelPair();
  const spawnFn = pipeSpawn();
  const service = createPtyService({
    spawn: (r) => (spawned.push(r), spawnFn(r)),
    git: { exec: opts.exec ?? pipeExec(execLog), gitPath: opts.gitPath ?? (GIT as string), hooksOff: "/dev/null", scratchParent, baseEnv, ...(opts.maxExecs === undefined ? {} : { maxExecs: opts.maxExecs }) },
  });
  service.serveControl(pair.b);
  const replies: Reply[] = [];
  pair.a.onMessage((m) => void replies.push(m as Reply));
  const identity = { GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.invalid" };
  const rig: GitRig = {
    tmp, scratchParent, home, globalConfig, service, pair, execLog, spawned, baseEnv, bin,
    async send(msg) {
      const req = msg["req"] as string;
      pair.a.send(msg);
      await until(() => replies.some((r) => r.req === req));
      return replies.find((r) => r.req === req) as Reply;
    },
    async exit(term) {
      await until(() => replies.some((r) => r.t === "exit" && r.term === term));
      return replies.find((r) => r.t === "exit" && r.term === term) as Reply;
    },
    git(args, cwd, input, extraEnv) {
      return execFileSync(GIT as string, args, { cwd, env: { ...baseEnv, ...identity, ...extraEnv }, input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    },
    repo(name) {
      const top = join(tmp, name);
      mkdirSync(top);
      rig.git(["init", "-q"], top);
      writeFileSync(join(top, "a.txt"), "alpha\n");
      rig.git(["add", "a.txt"], top);
      rig.git(["commit", "-q", "--no-verify", "-m", "init"], top);
      return { top, gitDir: join(top, ".git") };
    },
    marker(name, tail = "") {
      const p = join(bin, `marker-${name}-${++counter}`);
      writeFileSync(p, `#!/bin/sh\necho ${name} >> '${markerLog}'\n${tail}`);
      chmodSync(p, 0o755);
      return p;
    },
    markers: () => readFileSync(markerLog, "utf8"),
    cleanup() {
      service.dispose();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
  return rig;
}

let reqN = 0;
export const nextReq = (): string => `r${++reqN}`;

/** `scratch-begin` of `tree` (default HEAD's tree) for `repo`; returns the reply, the attempt and its derived paths. */
export async function begin(r: GitRig, repo: { top: string; gitDir: string }, opts: { tree?: string; attempt?: string } = {}): Promise<{ reply: Record<string, unknown>; attempt: string; dir: string; tree: string; treeDir: string }> {
  const tree = opts.tree ?? r.git(["rev-parse", "HEAD^{tree}"], repo.top).trim();
  const attempt = opts.attempt ?? `attempt-${nextReq()}`;
  const reply = await r.send({ t: "scratch-begin", req: nextReq(), attempt, gitDir: repo.gitDir, worktree: repo.top, tree });
  const dir = join(r.scratchParent, "hook-scratch", attempt);
  return { reply, attempt, dir, tree, treeDir: join(dir, "tree") };
}

export const verifyAttempt = (r: GitRig, attempt: string): Promise<Record<string, unknown>> => r.send({ t: "scratch-verify", req: nextReq(), attempt });

/** Writes `objects` (path -> [mode, blob id]) as one tree with `git mktree --missing` semantics; undefined if this git refuses the names. */
export function forgeTree(r: GitRig, top: string, rows: ReadonlyArray<readonly [string, string, string]>): string | undefined {
  try {
    return r.git(["mktree"], top, rows.map(([mode, oid, name]) => `${mode} ${mode === "040000" ? "tree" : mode === "160000" ? "commit" : "blob"} ${oid}\t${name}\n`).join("")).trim();
  } catch {
    return undefined;
  }
}
