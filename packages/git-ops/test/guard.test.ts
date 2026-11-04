// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { GitOpsError, guardedRunner, prefix } from "../src/index.js";
import { FakeRunner, WT, makeDeps } from "./helpers.js";

const run = async (argv: string[], over: Parameters<typeof makeDeps>[1] = {}): Promise<string> => {
  const r = new FakeRunner();
  const deps = makeDeps(r, over);
  try {
    await guardedRunner(r, deps).run({ argv, cwd: WT.workTree, env: {}, context: "daemon" });
    return "ran";
  } catch (e) {
    assert.ok(e instanceof GitOpsError);
    return e.code;
  }
};

const good = (over: Parameters<typeof makeDeps>[1] = {}): string[] => prefix(WT, makeDeps(new FakeRunner(), over), { context: "daemon", hooks: false, filters: [] });

test("N-1: the exact hardened prefix is accepted, with or without a subcommand", async () => {
  assert.equal(await run([...good(), "write-tree"]), "ran");
  assert.equal(await run([...good(), "--version"]), "ran");
});

test("N-1: dropping any one protection from the prefix is refused", async () => {
  const base = good();
  const without = (pred: (a: string, i: number, all: string[]) => boolean): string[] => base.filter((a, i, all) => !pred(a, i, all));
  const cfg = (key: string) => (a: string, i: number, all: string[]) => a === key || (all[i + 1] === key && a === "-c");
  for (const key of ["core.fsmonitor=false", "protocol.allow=never", "protocol.ext.allow=never", "commit.gpgsign=false", "core.askPass=", "diff.submodule=short", "core.hooksPath=/dev/null"]) {
    assert.equal(await run([...without(cfg(key)), "write-tree"]), "E_POLICY_DENIED", key);
  }
  for (const flag of ["--no-pager", "--no-replace-objects", `--git-dir=${WT.gitDir}`, `--work-tree=${WT.workTree}`]) {
    assert.equal(await run([...without((a) => a === flag), "write-tree"]), "E_POLICY_DENIED", flag);
  }
});

test("N-1: a protection placed after the subcommand does not count, and an empty hooks path is never accepted", async () => {
  const lone = ["--no-pager", "--no-replace-objects", `--git-dir=${WT.gitDir}`, `--work-tree=${WT.workTree}`];
  const rest = good().slice(lone.length);
  assert.equal(await run([...lone, "write-tree", ...rest]), "E_POLICY_DENIED");
  const win = { platform: "win32" as const };
  assert.equal(await run([...lone, "-c", "core.hooksPath=", "write-tree"], win), "E_POLICY_DENIED");
});
