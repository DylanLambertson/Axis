// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  GitOpsError, createNodeRunner, executeCommit, executePush, guardedRunner, planCommit, planPush, prefix,
} from "../src/index.js";
import { PATHS, baseOf, fixture, plantHook, refusal, stage } from "./realFixture.js";

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
  await planPush(f.deps, { worktree: f.wt, remote: "origin", branch: "axis/feat", baseSha: baseOf(f) });
  assert.equal(readFileSync(f.marker, "utf8"), "", "no daemon-side call ran planted code");
});

test("a hardened call runs no pre-push hook, a daemon-side push is refused by the transport allow-list, and the guard refuses an unhardened daemon call", async () => {
  const f = fixture();
  plantHook(f, "pre-push");
  const inner = createNodeRunner();
  const guarded = guardedRunner(inner, f.deps);
  const refspec = "refs/heads/axis/feat:refs/heads/axis/feat";
  const hardened = [...prefix(f.wt, f.deps, { context: "daemon", hooks: false, filters: [] }), "push", "--", "origin", refspec];
  const env = { PATH: PATHS, HOME: f.deps.env.daemon["HOME"] as string, GIT_TERMINAL_PROMPT: "0" };
  const r = await guarded.run({ argv: hardened, cwd: f.wt.workTree, env, context: "daemon" });
  assert.notEqual(r.code, 0, "the daemon never pushes");
  assert.match(r.stderr, /not allowed/);
  assert.equal(existsSync(f.marker), false, "pre-push hook did not run");
  assert.throws(() => execFileSync("git", ["--git-dir", f.remote, "rev-parse", "refs/heads/axis/feat"], { stdio: "ignore" }), "nothing was pushed");
  // The same hooks-off prefix in the pty context (user credentials, network allowed) pushes without running the hook.
  const pty = await inner.run({ argv: [...prefix(f.wt, f.deps, { context: "pty", hooks: false, filters: [] }), "push", "--no-verify", "--", "origin", refspec], cwd: f.wt.workTree, env, context: "pty" }).catch((e: unknown) => e);
  assert.ok(pty instanceof GitOpsError, "the daemon runner refuses the pty context");
  const unhardened = ["--git-dir=" + f.wt.gitDir, "push", "origin", "axis/feat"];
  const e = await refusal(guarded.run({ argv: unhardened, cwd: f.wt.workTree, env, context: "daemon" }));
  assert.equal(e.code, "E_POLICY_DENIED");
});

test("push: explicit refspec reaches the bare remote; the pre-push hook runs in the pty context only when hooks are on", async () => {
  const f = fixture();
  plantHook(f, "pre-push");
  await executePush(f.deps, { worktree: f.wt, remote: "origin", branch: "axis/feat", baseSha: baseOf(f) });
  assert.match(execFileSync("git", ["--git-dir", f.remote, "rev-parse", "refs/heads/axis/feat"], { encoding: "utf8" }), /^[0-9a-f]{40}\n$/);
  assert.equal(readFileSync(f.marker, "utf8"), "pre-push\n");
  const off = fixture({ runHooks: false });
  plantHook(off, "pre-push");
  await executePush(off.deps, { worktree: off.wt, remote: "origin", branch: "axis/feat", baseSha: baseOf(off) });
  assert.equal(existsSync(off.marker), false);
});

test("push: only the one branch goes; other refs, tags and force never do", async () => {
  const f = fixture();
  f.git("branch", "other");
  f.git("tag", "v1");
  await executePush(f.deps, { worktree: f.wt, remote: "origin", branch: "axis/feat", baseSha: baseOf(f) });
  const refs = execFileSync("git", ["--git-dir", f.remote, "for-each-ref", "--format=%(refname)"], { encoding: "utf8" }).trim().split("\n");
  assert.deepEqual(refs, ["refs/heads/axis/feat"]);
});

test("push: force and refspec tricks in the branch or remote are refused", async () => {
  const f = fixture();
  for (const branch of ["+axis/feat", "axis/feat:main", "axis/*", "main", ":axis/feat", "--force", "--upload-pack=touch /tmp/axis-pwned"]) {
    const e = await refusal(planPush(f.deps, { worktree: f.wt, remote: "origin", branch, baseSha: baseOf(f) }));
    assert.ok(e.code === "E_POLICY_DENIED" || e.code === "E_INVALID_ARGUMENT", branch);
  }
  for (const remote of ["--receive-pack=touch /tmp/axis-pwned", "-f", f.remote, "ext::sh -c touch% /tmp/axis-pwned"]) {
    const e = await refusal(planPush(f.deps, { worktree: f.wt, remote, branch: "axis/feat", baseSha: baseOf(f) }));
    assert.equal(e.code, "E_INVALID_ARGUMENT", remote);
  }
  assert.equal(existsSync("/tmp/axis-pwned"), false);
});

test("push: a configured remote with credentials in its URL is refused without echoing the password", async () => {
  const f = fixture();
  f.git("remote", "add", "cred", "https://user:hunter2@github.com/o/r.git");
  const e = await refusal(planPush(f.deps, { worktree: f.wt, remote: "cred", branch: "axis/feat", baseSha: baseOf(f) }));
  assert.equal(e.code, "E_POLICY_DENIED");
  assert.ok(!e.message.includes("hunter2"));
  f.git("remote", "add", "ext", "ext::sh -c true");
  assert.equal((await refusal(planPush(f.deps, { worktree: f.wt, remote: "ext", branch: "axis/feat", baseSha: baseOf(f) }))).code, "E_POLICY_DENIED");
});

test("push: drift refuses before anything is pushed; the secret scanner sees the real outgoing diff", async () => {
  const drifting = fixture({ assertNoDrift: async () => { throw new GitOpsError("E_POLICY_DENIED", "drift"); } });
  await refusal(executePush(drifting.deps, { worktree: drifting.wt, remote: "origin", branch: "axis/feat", baseSha: baseOf(drifting) }));
  assert.throws(() => execFileSync("git", ["--git-dir", drifting.remote, "rev-parse", "refs/heads/axis/feat"], { stdio: "ignore" }));

  let diff = "";
  const f = fixture({ scanner: async (d) => { diff = d; return /SECRET=/.test(d) ? [{ rule: "env-secret", path: ".env" }] : []; }, scanMode: "warn" });
  stage(f, ".env", "SECRET=abc\n");
  f.git("commit", "-q", "-m", "add env");
  const plan = await planPush(f.deps, { worktree: f.wt, remote: "origin", branch: "axis/feat", baseSha: baseOf(f) });
  assert.match(diff, /\+SECRET=abc/);
  assert.equal(plan.requiresConfirmation, true);
  await refusal(executePush(f.deps, { worktree: f.wt, remote: "origin", branch: "axis/feat", baseSha: baseOf(f) }));
  await executePush(f.deps, { worktree: f.wt, remote: "origin", branch: "axis/feat", baseSha: baseOf(f) }, { confirmed: true });
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

test("S-7: git itself refuses a remote-helper transport on the pty push, and the sanity case shows the helper would otherwise run", async () => {
  const f = fixture();
  const bin = join(f.root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "git-remote-foo"), `#!/bin/sh\necho helper >> "${f.marker}"\nexit 1\n`);
  chmodSync(join(bin, "git-remote-foo"), 0o755);
  const plan = await planPush(f.deps, { worktree: f.wt, remote: "origin", branch: "axis/feat", baseSha: baseOf(f) });
  const argv = [...plan.command.argv];
  const at = argv.lastIndexOf(plan.remote);
  argv[at] = "foo::x";
  const env = { ...plan.command.env, PATH: `${bin}:${PATHS}` };
  const run = createNodeRunner({ allowPtyContext: true }).run;
  const refused = await run({ ...plan.command, argv, env });
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /not allowed/);
  assert.equal(existsSync(f.marker), false, "the helper did not run");
  const open = argv.filter((a, i) => !(a.startsWith("protocol.") && argv[i - 1] === "-c") && !(a === "-c" && (argv[i + 1] ?? "").startsWith("protocol.")));
  await run({ ...plan.command, argv: open, env });
  assert.ok(existsSync(f.marker), "fixture: without the allow-list the helper runs");
});

test("S-4: a token-as-username https remote is refused", async () => {
  const f = fixture();
  f.git("remote", "add", "tok", `https://${["ghp", "_", "abcdefghijklmnopqrstuvwxyz0123456789"].join("")}@github.com/o/r.git`);
  assert.equal((await refusal(planPush(f.deps, { worktree: f.wt, remote: "tok", branch: "axis/feat", baseSha: baseOf(f) }))).code, "E_POLICY_DENIED");
});
