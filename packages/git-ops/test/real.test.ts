// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  GitOpsError, createNodeRunner, executeCommit, executePush, guardedRunner, planCommit, planPush, prefix,
} from "../src/index.js";
import { PATHS, fixture, plantHook, refusal, stage } from "./realFixture.js";

test("commit: the reviewed tree is committed with the config identity and hooks run in the pty context", async () => {
  const f = fixture();
  plantHook(f, "pre-commit");
  const tree = stage(f, "b.txt", "two\n");
  const r = await executeCommit(f.deps, { worktree: f.wt, reviewedTreeHash: tree, message: "feat: b\n\nbody", author: { name: "Dylan Lambertson", email: "me@dylanlambertson.dev" } });
  assert.equal(r.tree, tree);
  assert.equal(f.git("rev-parse", "HEAD^{tree}").trim(), tree);
  assert.equal(f.git("log", "-1", "--format=%an <%ae>|%cn <%ce>|%B").trim().split("|")[0], "Dylan Lambertson <me@dylanlambertson.dev>");
  assert.match(f.git("log", "-1", "--format=%B"), /feat: b\n\nbody/);
  assert.equal(readFileSync(f.marker, "utf8"), "pre-commit\n", "hook ran once, in the pty context");
  assert.ok(f.seen.filter((c) => c.context === "pty").length === 1);
});

test("commit with hooks off does not run a planted pre-commit hook", async () => {
  const f = fixture({ runHooks: false });
  plantHook(f, "pre-commit");
  plantHook(f, "commit-msg");
  const tree = stage(f, "b.txt", "two\n");
  await executeCommit(f.deps, { worktree: f.wt, reviewedTreeHash: tree, message: "feat: b" });
  assert.equal(existsSync(f.marker), false);
});

test("commit: a tree mismatch is refused and nothing is committed", async () => {
  const f = fixture();
  const reviewed = stage(f, "b.txt", "two\n");
  stage(f, "c.txt", "changed after review\n");
  const before = f.git("rev-parse", "HEAD").trim();
  const e = await refusal(executeCommit(f.deps, { worktree: f.wt, reviewedTreeHash: reviewed, message: "m" }));
  assert.equal(e.code, "E_CONFLICT");
  assert.equal(f.git("rev-parse", "HEAD").trim(), before);
});

test("commit: refused while a CLI run is active", async () => {
  const f = fixture({ isCliRunActive: () => true });
  const tree = stage(f, "b.txt", "two\n");
  const e = await refusal(executeCommit(f.deps, { worktree: f.wt, reviewedTreeHash: tree, message: "m" }));
  assert.equal(e.code, "E_POLICY_DENIED");
  assert.equal(f.seen.length, 0);
});

test("daemon-side reads run no hook and no fsmonitor, even with planted ones", async () => {
  const f = fixture();
  for (const h of ["pre-commit", "post-checkout", "pre-push", "post-index-change", "reference-transaction"]) plantHook(f, h);
  const fsmon = join(f.root, "fsmon.sh");
  writeFileSync(fsmon, `#!/bin/sh\necho fsmonitor >> "${f.marker}"\n`);
  chmodSync(fsmon, 0o755);
  f.git("config", "core.fsmonitor", fsmon);
  // Sanity: the fixture is not vacuous. An unhardened git call does run the planted code.
  f.git("status", "--porcelain");
  assert.ok(existsSync(f.marker) && readFileSync(f.marker, "utf8").includes("fsmonitor"), "fixture: fsmonitor runs when not disabled");
  writeFileSync(f.marker, "");
  const tree = stage(f, "b.txt", "two\n");
  writeFileSync(f.marker, "");
  await planCommit(f.deps, { worktree: f.wt, reviewedTreeHash: tree, message: "m" });
  await planPush(f.deps, { worktree: f.wt, remote: "origin", branch: "axis/feat" });
  assert.equal(readFileSync(f.marker, "utf8"), "", "no daemon-side call ran planted code");
});

test("a planted pre-push hook does not run on a daemon-side push, and the guard refuses an unhardened daemon call", async () => {
  const f = fixture();
  plantHook(f, "pre-push");
  const inner = createNodeRunner();
  const guarded = guardedRunner(inner, f.deps);
  const hardened = [...prefix(f.wt, f.deps, { context: "daemon", hooks: false, filters: [] }), "push", "--", "origin", "refs/heads/axis/feat:refs/heads/axis/feat"];
  const env = { PATH: PATHS, HOME: f.deps.env.daemon["HOME"] as string, GIT_TERMINAL_PROMPT: "0" };
  const r = await guarded.run({ argv: hardened, cwd: f.wt.workTree, env, context: "daemon" });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(existsSync(f.marker), false, "pre-push hook did not run");
  const unhardened = ["--git-dir=" + f.wt.gitDir, "push", "origin", "axis/feat"];
  const e = await refusal(guarded.run({ argv: unhardened, cwd: f.wt.workTree, env, context: "daemon" }));
  assert.equal(e.code, "E_POLICY_DENIED");
  await refusal(createNodeRunner().run({ argv: ["--version"], cwd: f.root, env, context: "pty" }));
});

test("push: explicit refspec reaches the bare remote; the pre-push hook runs in the pty context only when hooks are on", async () => {
  const f = fixture();
  plantHook(f, "pre-push");
  await executePush(f.deps, { worktree: f.wt, remote: "origin", branch: "axis/feat" });
  assert.match(execFileSync("git", ["--git-dir", f.remote, "rev-parse", "refs/heads/axis/feat"], { encoding: "utf8" }), /^[0-9a-f]{40}\n$/);
  assert.equal(readFileSync(f.marker, "utf8"), "pre-push\n");
  const off = fixture({ runHooks: false });
  plantHook(off, "pre-push");
  await executePush(off.deps, { worktree: off.wt, remote: "origin", branch: "axis/feat" });
  assert.equal(existsSync(off.marker), false);
});

test("push: only the one branch goes; other refs, tags and force never do", async () => {
  const f = fixture();
  f.git("branch", "other");
  f.git("tag", "v1");
  await executePush(f.deps, { worktree: f.wt, remote: "origin", branch: "axis/feat" });
  const refs = execFileSync("git", ["--git-dir", f.remote, "for-each-ref", "--format=%(refname)"], { encoding: "utf8" }).trim().split("\n");
  assert.deepEqual(refs, ["refs/heads/axis/feat"]);
});

test("push: force and refspec tricks in the branch or remote are refused", async () => {
  const f = fixture();
  for (const branch of ["+axis/feat", "axis/feat:main", "axis/*", "main", ":axis/feat", "--force", "--upload-pack=touch /tmp/axis-pwned"]) {
    const e = await refusal(planPush(f.deps, { worktree: f.wt, remote: "origin", branch }));
    assert.ok(e.code === "E_POLICY_DENIED" || e.code === "E_INVALID_ARGUMENT", branch);
  }
  for (const remote of ["--receive-pack=touch /tmp/axis-pwned", "-f", f.remote, "ext::sh -c touch% /tmp/axis-pwned"]) {
    const e = await refusal(planPush(f.deps, { worktree: f.wt, remote, branch: "axis/feat" }));
    assert.equal(e.code, "E_INVALID_ARGUMENT", remote);
  }
  assert.equal(existsSync("/tmp/axis-pwned"), false);
});

test("push: a configured remote with credentials in its URL is refused without echoing the password", async () => {
  const f = fixture();
  f.git("remote", "add", "cred", "https://user:hunter2@github.com/o/r.git");
  const e = await refusal(planPush(f.deps, { worktree: f.wt, remote: "cred", branch: "axis/feat" }));
  assert.equal(e.code, "E_POLICY_DENIED");
  assert.ok(!e.message.includes("hunter2"));
  f.git("remote", "add", "ext", "ext::sh -c true");
  assert.equal((await refusal(planPush(f.deps, { worktree: f.wt, remote: "ext", branch: "axis/feat" }))).code, "E_POLICY_DENIED");
});

test("push: drift refuses before anything is pushed; the secret scanner sees the real outgoing diff", async () => {
  const drifting = fixture({ assertNoDrift: async () => { throw new GitOpsError("E_POLICY_DENIED", "drift"); } });
  await refusal(executePush(drifting.deps, { worktree: drifting.wt, remote: "origin", branch: "axis/feat" }));
  assert.throws(() => execFileSync("git", ["--git-dir", drifting.remote, "rev-parse", "refs/heads/axis/feat"], { stdio: "ignore" }));

  let diff = "";
  const f = fixture({ scanner: async (d) => { diff = d; return /SECRET=/.test(d) ? [{ rule: "env-secret", path: ".env" }] : []; }, scanMode: "warn" });
  stage(f, ".env", "SECRET=abc\n");
  f.git("commit", "-q", "-m", "add env");
  const plan = await planPush(f.deps, { worktree: f.wt, remote: "origin", branch: "axis/feat", base: "main" });
  assert.match(diff, /\+SECRET=abc/);
  assert.equal(plan.requiresConfirmation, true);
  await refusal(executePush(f.deps, { worktree: f.wt, remote: "origin", branch: "axis/feat", base: "main" }));
  await executePush(f.deps, { worktree: f.wt, remote: "origin", branch: "axis/feat", base: "main" }, { confirmed: true });
});

test("a filter driver in the config is neutralised by the daemon prefix, and the fixture is not vacuous", async () => {
  const f = fixture();
  const filt = join(f.root, "filter.sh");
  writeFileSync(filt, `#!/bin/sh\necho filter >> "${f.marker}"\ncat\n`);
  chmodSync(filt, 0o755);
  f.git("config", "filter.x.clean", filt);
  f.git("config", "filter.x.smudge", filt);
  writeFileSync(join(f.wt.gitDir, "info", "attributes"), "*.txt filter=x\n");
  const tree = f.git("write-tree").trim();
  await planCommit(f.deps, { worktree: f.wt, reviewedTreeHash: tree, message: "m" }).catch(() => undefined);
  const call = f.seen.find((c) => c.context === "daemon" && c.argv.includes("write-tree"));
  assert.ok(call && call.argv.includes("filter.x.clean="), "the prefix neutralises the configured filter");
  const env = { PATH: PATHS, HOME: f.deps.env.daemon["HOME"] as string };
  const head = call.argv.slice(0, call.argv.indexOf("write-tree"));
  writeFileSync(join(f.wt.workTree, "a.txt"), "touched 1\n");
  execFileSync("git", [...head, "add", "-A"], { cwd: f.wt.workTree, env });
  assert.equal(existsSync(f.marker), false, "hardened add did not run the clean filter");
  writeFileSync(join(f.wt.workTree, "a.txt"), "touched 2\n");
  f.git("add", "-A");
  assert.ok(existsSync(f.marker), "an unhardened add does run it");
});
