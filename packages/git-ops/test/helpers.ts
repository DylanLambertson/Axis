// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { GitOpsDeps, GitRunRequest, GitRunResult, WorktreeRef } from "../src/index.js";

export const WT: WorktreeRef = { workTree: "/data/wt/proj-1/feat", gitDir: "/repo/.git/worktrees/feat" };
export const TREE = "a".repeat(40);
export const OTHER_TREE = "b".repeat(40);
export const HEAD = "c".repeat(40);
export const COMMIT = "e".repeat(40);
export const BASE = "9".repeat(40);

/** The subcommand and its arguments, after the global options that come first. */
export function sub(argv: readonly string[]): string[] {
  if (argv.at(-1) === "--version") return ["--version"];
  let i = 0;
  while (i < argv.length && (argv[i] as string).startsWith("-")) i += argv[i] === "-c" ? 2 : 1;
  return argv.slice(i);
}

export type Responder = (sub: string[], req: GitRunRequest) => Partial<GitRunResult> | undefined;

export class FakeRunner {
  readonly calls: GitRunRequest[] = [];
  constructor(private readonly responder: Responder = () => undefined) {}
  async run(req: GitRunRequest): Promise<GitRunResult> {
    this.calls.push(req);
    const r = this.responder(sub(req.argv), req) ?? {};
    return { code: 0, stdout: "", stderr: "", ...r };
  }
  subs(): string[][] {
    return this.calls.map((c) => sub(c.argv));
  }
  ptyCalls(): GitRunRequest[] {
    return this.calls.filter((c) => c.context === "pty");
  }
}

/** A responder for a healthy axis/feat worktree whose index tree is TREE. */
export function healthy(extra: Responder = () => undefined): Responder {
  return (s, req) => {
    const e = extra(s, req);
    if (e) return e;
    const k = s.join(" ");
    if (k === "--version") return { stdout: "git version 2.39.5 (Apple Git-154)\n" };
    if (s[0] === "config") return { code: 1 };
    if (k === "symbolic-ref --quiet --short HEAD") return { stdout: "axis/feat\n" };
    if (k === "write-tree") return { stdout: `${TREE}\n` };
    if (k === "rev-parse --verify --end-of-options HEAD^{commit}") return { stdout: `${HEAD}\n` };
    if (k === "rev-parse --verify --end-of-options HEAD^{tree}") return { stdout: `${OTHER_TREE}\n` };
    if (s[0] === "var") return { stdout: "Dylan Lambertson <me@dylanlambertson.dev> 1700000000 +0000\n" };
    if (k === "remote") return { stdout: "origin\n" };
    if (s[0] === "remote" && s[1] === "get-url") return { stdout: "https://github.com/o/r.git\n" };
    if (s[0] === "rev-parse" && s.includes("refs/heads/axis/feat^{commit}")) return { stdout: `${HEAD}\n` };
    if (s[0] === "rev-parse" && s.includes(`${BASE}^{commit}`)) return { stdout: `${BASE}\n` };
    if (s[0] === "merge-base") return { code: 0 };
    if (s[0] === "rev-parse") return { code: 1 };
    if (s[0] === "rev-list") return { stdout: `${COMMIT}\n` };
    if (s[0] === "diff-tree") return { stdout: "+hello\n" };
    if (s[0] === "hash-object") return { stdout: `${"4".repeat(40)}\n` };
    return undefined;
  };
}

export function makeDeps(runner: FakeRunner, over: Partial<GitOpsDeps> = {}): GitOpsDeps {
  return {
    runner,
    env: { daemon: { PATH: "/usr/bin", HOME: "/h" }, pty: { PATH: "/usr/bin", HOME: "/h", SSH_AUTH_SOCK: "/s" } },
    runHooks: true,
    isCliRunActive: () => false,
    assertNoDrift: async () => undefined,
    platform: "linux",
    ...over,
  };
}
