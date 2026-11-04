// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrokerFs, ContainDeps, RegisteredWorktree, WorktreeRegistry } from "../src/index.js";
import { nodeBrokerFs } from "../src/index.js";

export interface World {
  readonly base: string;
  /** A registered repository (the local checkout). */
  readonly repo: string;
  /** The registered worktree root. */
  readonly wt: string;
  /** A directory outside both. */
  readonly outside: string;
  readonly registry: WorktreeRegistry;
  deps(fs?: BrokerFs): ContainDeps;
  cleanup(): void;
}

/** Whether this host lets the test create symlinks (a plain Windows account may not). */
export function canSymlink(): boolean {
  const w = makeWorld();
  try {
    symlinkSync(w.outside, join(w.base, "probe"));
    return true;
  } catch {
    return false;
  } finally {
    w.cleanup();
  }
}

export function makeWorld(id = "wt1"): World {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "axis-broker-")));
  const repo = join(base, "repo");
  const wt = join(base, "app", "worktrees", "wt1");
  const outside = join(base, "outside");
  for (const d of [repo, wt, outside]) mkdirSync(d, { recursive: true });
  writeFileSync(join(outside, "secret.txt"), "TOP-SECRET");
  const entry: RegisteredWorktree = { id, root: wt, gitDir: join(base, "gitdir") };
  const registry: WorktreeRegistry = {
    get: (i) => (i === id ? entry : undefined),
    repositoryRoots: () => [repo],
  };
  return {
    base, repo, wt, outside, registry,
    deps: (fs = nodeBrokerFs) => ({ registry, fs }),
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}
