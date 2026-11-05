// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIN_GIT_VERSION } from "@axis/git-ops";

/**
 * The git fixture of the headless slice (plan section 1.1): a source repository and a bare remote named `origin`, made with
 * whatever git is installed. The initial branch is set with `symbolic-ref` (no `-b`), the identity lives in the repository's own
 * config, and nothing assumes a git version beyond `MIN_GIT_VERSION` or an operating system (paths come from `node:path`, git is
 * run without a shell). `gitSkipReason()` is the explicit reason to skip when git is missing or too old.
 */
export function gitSkipReason(): string | undefined {
  let out: string;
  try {
    out = execFileSync("git", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "git is not installed";
  }
  const m = /(\d+)\.(\d+)/.exec(out);
  if (m === null) return "the git version is unreadable";
  const [major, minor] = [Number(m[1]), Number(m[2])];
  return major > MIN_GIT_VERSION.major || (major === MIN_GIT_VERSION.major && minor >= MIN_GIT_VERSION.minor) ? undefined : "git is older than the product minimum";
}

export interface GitFixture {
  readonly root: string;
  readonly home: string;
  readonly repo: string;
  readonly remote: string;
  /** The environment git runs in, in the fixture and in the host child. */
  readonly env: Record<string, string>;
  git(cwd: string, ...args: string[]): string;
  /** Every ref of the bare remote as `name sha` lines (empty when none). */
  remoteRefs(): string[];
  /** A pre-commit hook that writes `marker` when it runs; `ran()` says whether it did. Returns false when this system cannot execute it. */
  plantHook(): { readonly marker: string; readonly works: boolean };
  cleanup(): void;
}

export function createGitFixture(): GitFixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "axis-slice-")));
  const home = join(root, "home");
  const repo = join(root, "repo");
  const remote = join(root, "remote.git");
  for (const d of [home, repo]) mkdirSync(d);
  const env: Record<string, string> = { PATH: process.env["PATH"] ?? "", HOME: home, USERPROFILE: home, GIT_CONFIG_NOSYSTEM: "1" };
  for (const name of ["SystemRoot", "SYSTEMROOT", "TEMP", "TMP"]) if (process.env[name] !== undefined) env[name] = process.env[name] as string;
  const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  git(root, "init", "-q", "--bare", remote);
  git(repo, "init", "-q");
  git(repo, "symbolic-ref", "HEAD", "refs/heads/main");
  for (const [k, v] of [["user.name", "Fixture"], ["user.email", "fixture@example.invalid"], ["commit.gpgsign", "false"]] as const) git(repo, "config", k, v);
  git(repo, "remote", "add", "origin", remote);
  writeFileSync(join(repo, "README.txt"), "fixture\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  return {
    root,
    home,
    repo,
    remote,
    env,
    git,
    remoteRefs: () => git(root, "--git-dir", remote, "for-each-ref", "--format=%(refname) %(objectname)").split("\n").filter((l) => l !== ""),
    plantHook() {
      const marker = join(root, "hook-ran.txt");
      const hook = join(repo, ".git", "hooks", "pre-commit");
      mkdirSync(join(repo, ".git", "hooks"), { recursive: true });
      writeFileSync(hook, `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`);
      chmodSync(hook, 0o755);
      // Prove the hook can run here at all, so "it did not run" below means something.
      let works = false;
      try {
        execFileSync(hook, [], { stdio: "ignore" });
        works = existsSync(marker);
      } catch {
        works = false;
      }
      rmSync(marker, { force: true });
      return { marker, works };
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** A credential-shaped canary built at run time (AWS access key id form), so no source line holds one. */
export function canary(seed = 7): string {
  let a = seed >>> 0;
  let s = "";
  for (let i = 0; i < 16; i++) {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    s += B32[Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * B32.length)];
  }
  return "AK" + "IA" + s;
}
