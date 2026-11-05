// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { GitOpsError, executeCommit, planCommit } from "../src/index.js";
import { FakeRunner, HEAD, OTHER_TREE, TREE, WT, healthy, makeDeps, sub } from "./helpers.js";

const input = { worktree: WT, reviewedTreeHash: TREE, message: "feat: add thing", expectedParent: HEAD, expectedBranch: "axis/feat" };

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof GitOpsError, String(e));
    return e.code;
  }
  return "OK";
}

test("the message never appears in argv, even when it looks like an option", async () => {
  const r = new FakeRunner(healthy());
  const msg = "--amend\n-m injected";
  const plan = await planCommit(makeDeps(r), { ...input, message: msg });
  assert.equal(plan.command.argv.some((a) => a.includes("amend") || a.includes("injected")), false);
  assert.equal(plan.command.stdin, "--amend\n-m injected\n");
  assert.equal(plan.command.env["GIT_TERMINAL_PROMPT"], "0");
  assert.equal(plan.command.env["SSH_AUTH_SOCK"], "/s");
  assert.ok(plan.command.argv.includes(`--git-dir=${WT.gitDir}`));
  assert.equal(plan.parent, HEAD);
});

test("author and committer are never overridden", async () => {
  const r = new FakeRunner(healthy());
  const plan = await planCommit(makeDeps(r), { ...input, author: { name: "Dylan Lambertson", email: "me@dylanlambertson.dev" } });
  assert.equal(plan.command.argv.some((a) => /author|committer|user\./i.test(a)), false);
  assert.equal(Object.keys(plan.command.env).some((n) => /^GIT_(AUTHOR|COMMITTER)/.test(n)), false);
});

test("an identity override in the environment is refused", async () => {
  for (const n of [
    "GIT_AUTHOR_DATE", "git_committer_date", "GIT_CONFIG_COUNT", "GIT_DIR", "GIT_INDEX_FILE",
    "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_REPLACE_REF_BASE", "GIT_PREFIX",
    "GIT_NO_REPLACE_OBJECTS", "GIT_SHALLOW_FILE", "GIT_CEILING_DIRECTORIES", "GIT_DISCOVERY_ACROSS_FILESYSTEM", "git_common_dir",
  ]) {
    const deps = makeDeps(new FakeRunner(healthy()), { env: { daemon: {}, pty: { PATH: "/b", [n]: "x" } } });
    assert.equal(await code(planCommit(deps, input)), "E_POLICY_DENIED", n);
  }
});

test("a configured identity that differs from the expected one is refused", async () => {
  const r = new FakeRunner(healthy());
  assert.equal(await code(planCommit(makeDeps(r), { ...input, author: { name: "Evil", email: "e@x" } })), "E_POLICY_DENIED");
});

test("REV-1: an index tree that differs from the reviewed tree is refused", async () => {
  const r = new FakeRunner(healthy((s) => (s[0] === "write-tree" ? { stdout: `${OTHER_TREE}\n` } : undefined)));
  assert.equal(await code(planCommit(makeDeps(r), input)), "E_CONFLICT");
  assert.equal(r.ptyCalls().length, 0);
});

test("L24: a commit is refused while a CLI run is active, before any git call", async () => {
  const r = new FakeRunner(healthy());
  const deps = makeDeps(r, { isCliRunActive: () => true });
  assert.equal(await code(planCommit(deps, input)), "E_POLICY_DENIED");
  assert.equal(r.calls.length, 0);
});

test("L24 applies to an asynchronous predicate", async () => {
  const deps = makeDeps(new FakeRunner(healthy()), { isCliRunActive: async () => true });
  assert.equal(await code(executeCommit(deps, input)), "E_POLICY_DENIED");
});

test("GIT-SNAP-1 drift refuses the commit", async () => {
  const r = new FakeRunner(healthy());
  const deps = makeDeps(r, { assertNoDrift: async () => { throw new GitOpsError("E_POLICY_DENIED", "drift"); } });
  assert.equal(await code(planCommit(deps, input)), "E_POLICY_DENIED");
  assert.equal(r.ptyCalls().length, 0);
});

test("runHooks only decides the hooks path of the pty commit-tree call; commit-tree has no --no-verify to add", async () => {
  const off = await planCommit(makeDeps(new FakeRunner(healthy()), { runHooks: false }), input);
  assert.ok(off.command.argv.includes("core.hooksPath=/dev/null"));
  assert.equal(off.command.argv.includes("--no-verify"), false);
  const on = await planCommit(makeDeps(new FakeRunner(healthy())), input);
  assert.equal(on.command.argv.some((a) => a.includes("hooksPath")), false);
});

test("every daemon-context call has an empty hooks path and no hook-capable defaults", async () => {
  const r = new FakeRunner(healthy());
  await planCommit(makeDeps(r), input);
  const daemon = r.calls.filter((c) => c.context === "daemon");
  assert.ok(daemon.length >= 5);
  for (const c of daemon) {
    assert.ok(c.argv.includes("core.hooksPath=/dev/null"), sub(c.argv).join(" "));
    assert.ok(c.argv.includes("core.fsmonitor=false"));
    assert.ok(c.argv.includes("commit.gpgsign=false"));
    assert.equal(Object.keys(c.env).some((n) => /^GIT_/.test(n) && n !== "GIT_TERMINAL_PROMPT"), false);
  }
});

test("filter drivers present in the config are neutralised on daemon calls", async () => {
  const r = new FakeRunner(
    healthy((s) =>
      s[0] === "config" ? { stdout: "filter.lfs.clean\0filter.lfs.smudge\0filter.evil.process\0filter.evil.required\0" } : undefined,
    ),
  );
  await planCommit(makeDeps(r), input);
  const wt = r.calls.find((c) => sub(c.argv)[0] === "write-tree");
  assert.ok(wt);
  for (const f of ["lfs", "evil"]) {
    for (const k of ["clean", "smudge", "process"]) assert.ok(wt.argv.includes(`filter.${f}.${k}=`), `${f}.${k}`);
    assert.ok(wt.argv.includes(`filter.${f}.required=false`));
  }
});

test("a filter with an unsafe name is refused", async () => {
  const r = new FakeRunner(healthy((s) => (s[0] === "config" ? { stdout: "filter.a b.clean\0" } : undefined)));
  assert.equal(await code(planCommit(makeDeps(r), input)), "E_POLICY_DENIED");
});

test("bad input is refused: tree hash, message, paths, detached HEAD, other branch", async () => {
  const mk = (over: Record<string, unknown>) => planCommit(makeDeps(new FakeRunner(healthy())), { ...input, ...over } as typeof input);
  assert.equal(await code(mk({ reviewedTreeHash: "HEAD" })), "E_INVALID_ARGUMENT");
  assert.equal(await code(mk({ reviewedTreeHash: "A".repeat(40) })), "E_INVALID_ARGUMENT");
  assert.equal(await code(mk({ message: "  " })), "E_INVALID_ARGUMENT");
  assert.equal(await code(mk({ message: "a\0b" })), "E_INVALID_ARGUMENT");
  assert.equal(await code(mk({ message: "x".repeat(70000) })), "E_INVALID_ARGUMENT");
  assert.equal(await code(mk({ worktree: { workTree: "rel", gitDir: "/g" } })), "E_INVALID_ARGUMENT");
  assert.equal(await code(mk({ worktree: { workTree: "/a/../b", gitDir: "/g" } })), "E_INVALID_ARGUMENT");
  const detached = new FakeRunner(healthy((s) => (s[0] === "symbolic-ref" ? { code: 1 } : undefined)));
  assert.equal(await code(planCommit(makeDeps(detached), input)), "E_POLICY_DENIED");
  const main = new FakeRunner(healthy((s) => (s[0] === "symbolic-ref" ? { stdout: "main\n" } : undefined)));
  assert.equal(await code(planCommit(makeDeps(main), input)), "E_POLICY_DENIED");
  const leading = new FakeRunner(healthy((s) => (s[0] === "symbolic-ref" ? { stdout: "axis/-x\n" } : undefined)));
  assert.equal(await code(planCommit(makeDeps(leading), input)), "E_POLICY_DENIED");
});

test("nothing to commit and a missing identity are refused", async () => {
  const same = new FakeRunner(healthy((s) => (s.join(" ").endsWith("HEAD^{tree}") ? { stdout: `${TREE}\n` } : undefined)));
  assert.equal(await code(planCommit(makeDeps(same), input)), "E_INVALID_ARGUMENT");
  const noId = new FakeRunner(healthy((s) => (s[0] === "var" ? { code: 128 } : undefined)));
  assert.equal(await code(planCommit(makeDeps(noId), input)), "E_POLICY_DENIED");
});

const NEW = "d".repeat(40);

/** A fake repository that answers the bound flow; `over` changes one answer. */
function bound(over: { tree?: string; parents?: string; update?: number; ref?: string; readBack?: string; tree2?: string } = {}) {
  let made = false;
  return new FakeRunner(
    healthy((s, req) => {
      if (req.context === "pty" && s[0] === "commit-tree") {
        made = true;
        return { stdout: `${NEW}\n` };
      }
      if (!made) return undefined;
      const k = s.join(" ");
      if (s[0] === "rev-list") return { stdout: `${over.parents ?? `${NEW} ${HEAD}`}\n` };
      if (k === `rev-parse --verify --end-of-options ${NEW}^{tree}`) return { stdout: `${over.tree ?? TREE}\n` };
      if (s[0] === "update-ref") return { code: over.update ?? 0, stderr: "fatal: cannot lock ref '/secret/path.lock'" };
      if (s[0] === "rev-parse" && s.includes("--quiet")) return over.ref === undefined ? { stdout: `${HEAD}\n` } : { stdout: `${over.ref}\n` };
      if (k === "rev-parse --verify --end-of-options refs/heads/axis/feat^{commit}") return { stdout: `${over.readBack ?? NEW}\n` };
      return undefined;
    }),
  );
}

async function failure(p: Promise<unknown>): Promise<GitOpsError> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof GitOpsError, String(e));
    return e;
  }
  assert.fail("expected a refusal");
}

test("execute: success returns the commit and tree, and the ref moves by compare-and-swap from the expected parent", async () => {
  const r = bound();
  assert.deepEqual(await executeCommit(makeDeps(r), input), { commit: NEW, tree: TREE });
  const update = r.calls.find((c) => sub(c.argv)[0] === "update-ref");
  assert.ok(update);
  assert.deepEqual(sub(update.argv).slice(-3), ["refs/heads/axis/feat", NEW, HEAD]);
  assert.equal(update.context, "daemon");
});

test("execute: a new commit with another parent, two parents or another tree is never put on the branch", async () => {
  for (const over of [{ parents: `${NEW} ${"f".repeat(40)}` }, { parents: `${NEW} ${HEAD} ${"f".repeat(40)}` }, { tree: OTHER_TREE }, { parents: NEW }]) {
    const r = bound(over);
    const e = await failure(executeCommit(makeDeps(r), input));
    assert.equal(e.code, "E_INTERNAL", JSON.stringify(over));
    assert.deepEqual(e.details, { updated: false });
    assert.equal(r.calls.some((c) => sub(c.argv)[0] === "update-ref"), false);
  }
});

test("execute: a lost compare-and-swap is head_moved when the ref moved, ref_update_failed when it did not, and git's text is not echoed", async () => {
  const moved = await failure(executeCommit(makeDeps(bound({ update: 1, ref: "f".repeat(40) })), input));
  assert.equal(moved.code, "E_CONFLICT");
  assert.equal(moved.details?.["reason"], "head_moved");
  const locked = await failure(executeCommit(makeDeps(bound({ update: 1 })), input));
  assert.equal(locked.code, "E_CONFLICT");
  assert.equal(locked.details?.["reason"], "ref_update_failed");
  assert.doesNotMatch(locked.message, /secret|\.lock/);
});

test("execute: a branch that does not point at the new commit after the update is reported, not rolled back", async () => {
  const e = await failure(executeCommit(makeDeps(bound({ readBack: "f".repeat(40) })), input));
  assert.equal(e.code, "E_INTERNAL");
  assert.deepEqual(e.details, { updated: true, rolledBack: false });
});

test("N-3: a GIT_AUTHOR_*/GIT_COMMITTER_* that matches the configured identity is allowed; one that would change it is refused", async () => {
  const mk = (pty: Record<string, string>) => makeDeps(new FakeRunner(healthy()), { env: { daemon: {}, pty: { PATH: "/b", ...pty } } });
  const same = { GIT_AUTHOR_NAME: "Dylan Lambertson", GIT_AUTHOR_EMAIL: "me@dylanlambertson.dev", GIT_COMMITTER_NAME: "Dylan Lambertson", GIT_COMMITTER_EMAIL: "me@dylanlambertson.dev" };
  assert.equal(await code(planCommit(mk(same), input)), "OK");
  for (const bad of [{ GIT_AUTHOR_NAME: "Evil" }, { GIT_AUTHOR_EMAIL: "e@x" }, { GIT_COMMITTER_NAME: "Evil" }, { git_committer_email: "e@x" }]) {
    const e = await failure(planCommit(mk(bad), input));
    assert.equal(e.code, "E_POLICY_DENIED", JSON.stringify(bad));
    assert.match(e.message, /unset it or make it match/);
  }
});

test("N-3: GIT_* variables in the daemon environment are stripped, not refused; the pty-side message says how to fix it", async () => {
  const deps = makeDeps(new FakeRunner(healthy()), { env: { daemon: { PATH: "/usr/bin", GIT_AUTHOR_NAME: "x", GIT_CONFIG_GLOBAL: "/x", GIT_DIR: "/y" }, pty: { PATH: "/b" } } });
  assert.equal(await code(planCommit(deps, input)), "OK");
  const bad = await failure(planCommit(makeDeps(new FakeRunner(healthy()), { env: { daemon: {}, pty: { PATH: "/b", GIT_CONFIG_GLOBAL: "/x" } } }), input));
  assert.match(bad.message, /GIT_CONFIG_GLOBAL.*unset it in the shell profile/);
});

test("a failed commit-tree is a conflict with a fixed message: git's stderr (paths, signer output) is not carried", async () => {
  const stderr = "error: gpg failed to sign the data in /home/someone/.gnupg\u001b[31m\n";
  const r = new FakeRunner(healthy((s, req) => (req.context === "pty" && s[0] === "commit-tree" ? { code: 128, stderr } : undefined)));
  const e = await failure(executeCommit(makeDeps(r), input));
  assert.equal(e.code, "E_CONFLICT");
  assert.equal(e.message, "git commit-tree failed (exit 128); the branch was not updated");
  assert.equal(r.calls.some((c) => sub(c.argv)[0] === "update-ref"), false);
});
