// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { takeSnapshot, type Limits, type Snapshot } from "../src/index.js";

export function git(cwd: string, ...args: string[]): string {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("GIT_")) env[k] = v;
  env["GIT_CONFIG_NOSYSTEM"] = "1";
  env["GIT_CONFIG_GLOBAL"] = process.platform === "win32" ? "NUL" : "/dev/null";
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

export interface Fixture {
  readonly root: string;
  readonly main: string;
  readonly wt: string;
  readonly common: string;
  readonly home: string;
  snap(limits?: Partial<Limits>, extra?: { expectedGitDir?: string }): Promise<Snapshot>;
  cleanup(): void;
}

/** A real repository with one linked worktree, made with the installed git. */
export function makeFixture(): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "axis-snap-")));
  const main = join(root, "main");
  const home = join(root, "home");
  mkdirSync(main);
  mkdirSync(home);
  git(main, "init", "-q");
  git(main, "commit", "-q", "--allow-empty", "-m", "init");
  const wt = join(root, "wt");
  git(main, "worktree", "add", "-q", "-b", "axis/test", wt);
  const common = join(main, ".git");
  const f: Fixture = {
    root,
    main,
    wt,
    common,
    home,
    snap: (limits, extra) =>
      takeSnapshot({ worktreePath: wt, commonDir: common, homeDir: home, ...(limits === undefined ? {} : { limits }), ...(extra ?? {}) }),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
  return f;
}

export const write = (p: string, s: string, mode?: number): void => writeFileSync(p, s, mode === undefined ? {} : { mode });
export const append = (p: string, s: string): void => appendFileSync(p, s);
