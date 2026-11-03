// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Real-git fixture: a throwaway repository on axis/feat, a bare local remote, and a runner that records requests.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitOpsError, createNodeRunner, type GitOpsDeps, type GitRunRequest, type WorktreeRef } from "../src/index.js";

export const PATHS = process.env["PATH"] ?? "/usr/bin:/bin";

export interface Fixture {
  readonly home: string;
  readonly env: Record<string, string>;
  run(cwd: string, ...args: string[]): string;
  readonly root: string;
  readonly wt: WorktreeRef;
  readonly remote: string;
  readonly marker: string;
  readonly deps: GitOpsDeps;
  readonly seen: GitRunRequest[];
  git(...args: string[]): string;
}

export function fixture(over: Partial<GitOpsDeps> = {}): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "axis-gitops-")));
  const home = join(root, "home");
  mkdirSync(home);
  const env = { PATH: PATHS, HOME: home, GIT_CONFIG_NOSYSTEM: "1" };
  const repo = join(root, "repo");
  const remote = join(root, "remote.git");
  const run = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, env, encoding: "utf8" });
  run(root, "init", "-q", "--bare", remote);
  run(root, "init", "-q", "-b", "main", repo);
  for (const [k, v] of [["user.name", "Dylan Lambertson"], ["user.email", "me@dylanlambertson.dev"], ["commit.gpgsign", "false"]] as const) run(repo, "config", k, v);
  writeFileSync(join(repo, "a.txt"), "one\n");
  run(repo, "add", "-A");
  run(repo, "commit", "-q", "-m", "base");
  run(repo, "checkout", "-q", "-b", "axis/feat");
  run(repo, "remote", "add", "origin", remote);
  const seen: GitRunRequest[] = [];
  const inner = createNodeRunner({ allowPtyContext: true });
  const runner = { run: (req: GitRunRequest) => { seen.push(req); return inner.run(req); } };
  const deps: GitOpsDeps = {
    runner,
    env: { daemon: { PATH: PATHS, HOME: home }, pty: { PATH: PATHS, HOME: home } },
    runHooks: true,
    isCliRunActive: () => false,
    assertNoDrift: async () => undefined,
    ...over,
  };
  return { root, home, env, run, wt: { workTree: repo, gitDir: join(repo, ".git") }, remote, marker: join(root, "marker"), deps, seen, git: (...a) => run(repo, ...a) };
}

export function plantHook(f: Fixture, name: string): void {
  const p = join(f.wt.gitDir, "hooks", name);
  mkdirSync(join(f.wt.gitDir, "hooks"), { recursive: true });
  writeFileSync(p, `#!/bin/sh\necho ${name} >> "${f.marker}"\nexit 0\n`);
  chmodSync(p, 0o755);
}

export function stage(f: Fixture, file: string, text: string): string {
  writeFileSync(join(f.wt.workTree, file), text);
  f.git("add", "-A");
  return f.git("write-tree").trim();
}

export async function refusal(p: Promise<unknown>): Promise<GitOpsError> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof GitOpsError, String(e));
    return e;
  }
  assert.fail("expected a refusal");
}

