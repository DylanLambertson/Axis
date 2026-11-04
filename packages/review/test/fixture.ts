// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Real-git fixture: a throwaway repository with one base commit on axis/feat, the node runner, and a temporary-index
// provider that counts what it hands out so a test can prove nothing was left behind.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createNodeRunner, type GitOpsDeps, type GitRunRequest, type WorktreeRef } from "@axis/git-ops";
import { ReviewError, type ReviewDeps, type TempIndexProvider } from "../src/index.js";

export const PATHS = process.env["PATH"] ?? "/usr/bin:/bin";

export interface Fixture {
  readonly root: string;
  readonly repo: string;
  readonly home: string;
  readonly wt: WorktreeRef;
  readonly deps: ReviewDeps;
  readonly gitOps: GitOpsDeps;
  readonly seen: GitRunRequest[];
  readonly indexes: { created: number; disposed: number; dir: string };
  git(...args: string[]): string;
  write(rel: string, data: string | Buffer): void;
  head(): string;
  cleanup(): void;
}

export function tempIndexes(dir: string): { provider: TempIndexProvider; counts: Fixture["indexes"] } {
  mkdirSync(dir, { recursive: true });
  const counts = { created: 0, disposed: 0, dir };
  return {
    counts,
    provider: {
      async create() {
        const path = join(dir, `index-${counts.created++}`);
        return {
          path,
          async dispose() {
            counts.disposed++;
            rmSync(path, { force: true });
          },
        };
      },
    },
  };
}

export function fixture(over: { objectFormat?: "sha1" | "sha256"; deps?: Partial<ReviewDeps>; git?: Partial<GitOpsDeps>; base?: (f: { repo: string; git: (...a: string[]) => string; write: (rel: string, d: string | Buffer) => void }) => void } = {}): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "axis-review-")));
  const home = join(root, "home");
  mkdirSync(home);
  const env = { PATH: PATHS, HOME: home, GIT_CONFIG_NOSYSTEM: "1" };
  const repo = join(root, "repo");
  const run = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, env, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  run(root, "init", "-q", ...(over.objectFormat ? [`--object-format=${over.objectFormat}`] : []), "-b", "main", repo);
  for (const [k, v] of [["user.name", "Dylan Lambertson"], ["user.email", "me@dylanlambertson.dev"], ["commit.gpgsign", "false"]] as const) run(repo, "config", k, v);
  const git = (...a: string[]): string => run(repo, ...a);
  const write = (rel: string, data: string | Buffer): void => {
    const p = join(repo, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, data);
  };
  write("a.txt", Array.from({ length: 20 }, (_, i) => `l${i + 1}\n`).join(""));
  write("keep.txt", "keep\n");
  over.base?.({ repo, git, write });
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  git("checkout", "-q", "-b", "axis/feat");

  const seen: GitRunRequest[] = [];
  const inner = createNodeRunner({ allowPtyContext: true });
  const runner = { run: (req: GitRunRequest) => { seen.push(req); return inner.run(req); } };
  const gitOps: GitOpsDeps = {
    runner,
    env: { daemon: { PATH: PATHS, HOME: home }, pty: { PATH: PATHS, HOME: home } },
    runHooks: false,
    isCliRunActive: () => false,
    assertNoDrift: async () => undefined,
    ...over.git,
  };
  const { provider, counts } = tempIndexes(join(root, "indexes"));
  const deps: ReviewDeps = { git: gitOps, tempIndex: provider, ...over.deps };
  return {
    root, repo, home, wt: { workTree: repo, gitDir: join(repo, ".git") }, deps, gitOps, seen, indexes: counts, git, write,
    head: () => git("rev-parse", "HEAD").trim(),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

export function leftoverIndexes(f: Fixture): string[] {
  return existsSync(f.indexes.dir) ? readdirSync(f.indexes.dir) : [];
}

export async function refusal(p: Promise<unknown>): Promise<ReviewError> {
  try {
    await p;
  } catch (e) {
    if (!(e instanceof ReviewError)) throw e;
    return e;
  }
  throw new Error("expected a refusal");
}
