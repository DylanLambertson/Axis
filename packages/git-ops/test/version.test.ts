// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { daemonGitFor } from "../src/args.js";
import { GitOpsError, requireGitVersion } from "../src/index.js";
import { FakeRunner, WT, healthy, makeDeps } from "./helpers.js";

const unavailable = (e: unknown): boolean => e instanceof GitOpsError && e.code === "E_UNAVAILABLE";

function runnerReporting(stdout: string, code = 0): FakeRunner {
  return new FakeRunner(healthy((s) => (s.join(" ") === "--version" ? { stdout, code } : undefined)));
}

test("git older than 2.24 is refused with E_UNAVAILABLE", async () => {
  const deps = makeDeps(runnerReporting("git version 2.23.0\n"));
  await assert.rejects(() => requireGitVersion(deps, WT, {}), unavailable);
  await assert.rejects(() => daemonGitFor(WT, deps), unavailable);
  await assert.rejects(() => requireGitVersion(makeDeps(runnerReporting("git version 1.9.5\n")), WT, {}), unavailable);
});

test("git 2.24 exactly, 2.39.5 (Apple Git) and a future major version are accepted", async () => {
  for (const out of ["git version 2.24.0\n", "git version 2.39.5 (Apple Git-154)\n", "git version 3.0.1\n", "git version 2.100.0.windows.1\n"]) {
    await requireGitVersion(makeDeps(runnerReporting(out)), WT, {});
  }
});

test("unparseable output or a failing git is refused", async () => {
  for (const out of ["", "garbage", "git version\n", "git version x.y\n", "not git version 2.40.0\n"]) {
    await assert.rejects(() => requireGitVersion(makeDeps(runnerReporting(out)), WT, {}), unavailable, out);
  }
  await assert.rejects(() => requireGitVersion(makeDeps(runnerReporting("git version 2.40.0\n", 127)), WT, {}), unavailable);
});

test("a successful check is remembered per runner; a failure is not", async () => {
  const ok = runnerReporting("git version 2.39.5 (Apple Git-154)\n");
  const deps = makeDeps(ok);
  await daemonGitFor(WT, deps);
  await daemonGitFor(WT, deps);
  assert.equal(ok.calls.filter((c) => c.argv.at(-1) === "--version").length, 1);

  const bad = runnerReporting("git version 2.23.0\n");
  const badDeps = makeDeps(bad);
  await assert.rejects(() => daemonGitFor(WT, badDeps), unavailable);
  await assert.rejects(() => daemonGitFor(WT, badDeps), unavailable);
  assert.equal(bad.calls.filter((c) => c.argv.at(-1) === "--version").length, 2);
});
