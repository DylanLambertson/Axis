// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Helpers for the bound-commit tests: a stage-and-describe step and a runner wrapper that acts like a racing process.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CommitInput, GitOpsDeps, GitRunRequest, GitRunResult } from "../src/index.js";
import { stage, type Fixture } from "./realFixture.js";

/** The subcommand of a request (the first argument after the global options). */
export function subOf(req: GitRunRequest): string {
  let i = 0;
  while (i < req.argv.length && (req.argv[i] as string).startsWith("-")) i += req.argv[i] === "-c" ? 2 : 1;
  return req.argv[i] ?? "";
}

/** Stages b.txt and returns the commit input a review of it would hand over (HEAD and branch as they are now). */
export function reviewed(f: Fixture, message = "m", worktree = f.wt, branch = "axis/feat"): CommitInput & { expectedParent: string } {
  const text = "two\n";
  writeFileSync(join(worktree.workTree, "b.txt"), text);
  f.run(worktree.workTree, "add", "-A");
  const reviewedTreeHash = f.run(worktree.workTree, "write-tree").trim();
  const expectedParent = f.run(worktree.workTree, "rev-parse", "HEAD").trim();
  return { worktree, reviewedTreeHash, message, expectedParent, expectedBranch: branch };
}

export { stage };

type Hook = (req: GitRunRequest) => void | Promise<void>;

/** Runs `before` ahead of every request for which `when` holds, once unless `every` is set; `after` runs once it finished. */
export function around(f: Fixture, when: (r: GitRunRequest) => boolean, hooks: { before?: Hook; after?: Hook; every?: boolean }): GitOpsDeps {
  const inner = f.deps.runner;
  let fired = false;
  return {
    ...f.deps,
    runner: {
      run: async (req): Promise<GitRunResult> => {
        const hit = when(req) && (hooks.every === true || !fired);
        if (hit) fired = true;
        if (hit) await hooks.before?.(req);
        const r = await inner.run(req);
        if (hit) await hooks.after?.(req);
        return r;
      },
    },
  };
}

export const isPtyCommitTree = (r: GitRunRequest): boolean => r.context === "pty" && subOf(r) === "commit-tree";
export const isDaemon = (name: string) => (r: GitRunRequest): boolean => r.context === "daemon" && subOf(r) === name;

/** Another process adds other.txt on a new commit and moves the branch (`commit-tree` + `update-ref`): index and worktree are not touched. */
export function foreignCommit(f: Fixture, branch = "axis/feat"): string {
  const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: f.wt.workTree, env: f.env, encoding: "utf8", input: "foreign\n" }).trim();
  const entries = f.git("ls-tree", "HEAD") + `100644 blob ${blob}\tother.txt\n`;
  const tree = execFileSync("git", ["mktree"], { cwd: f.wt.workTree, env: f.env, encoding: "utf8", input: entries }).trim();
  const x = f.git("commit-tree", tree, "-p", "HEAD", "-m", "foreign").trim();
  f.git("update-ref", `refs/heads/${branch}`, x);
  return x;
}
