// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// TEST ONLY: fixtures for the `push` message tests (H9-hooks S4).
import { join } from "node:path";
import { PUSH_ENV_NAMES } from "../src/index.js";
import { nextReq, type GitRig } from "./git.js";

/** What the host would send for a pty process started with `base`: each configuration and ssh variable's value, or null. */
export const expectOf = (base: Record<string, string>): Record<string, string | null> => Object.fromEntries(PUSH_ENV_NAMES.map((n) => [n, base[n] ?? null]));

/** A repository on `axis/feat` with a bare remote `origin` (a path), and the push message for its tip. */
export function fixture(r: GitRig, name = "work"): { top: string; gitDir: string; remote: string; tip: string; msg: (extra?: Record<string, unknown>) => Record<string, unknown> } {
  const { top, gitDir } = r.repo(name);
  const remote = join(r.tmp, `${name}-remote.git`);
  r.git(["init", "-q", "--bare", remote], r.tmp);
  r.git(["remote", "add", "origin", remote], top);
  const tip = r.git(["rev-parse", "HEAD"], top).trim();
  const msg = (extra: Record<string, unknown> = {}) => ({ t: "push", req: nextReq(), runId: "run-push", repo: { gitDir, workTree: top }, remote: "origin", refspec: `${tip}:refs/heads/axis/feat`, env: { LANG: "C", GIT_TERMINAL_PROMPT: "1" }, expectEnv: expectOf(r.baseEnv), cols: 80, rows: 24, ...extra });
  return { top, gitDir, remote, tip, msg };
}
export const remoteRefs = (r: GitRig, remote: string): string => r.git(["--git-dir", remote, "for-each-ref", "--format=%(refname) %(objectname)"], r.tmp).trim();
