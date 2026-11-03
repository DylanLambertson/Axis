// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { GitOpsError, executePush, isAllowedRefspec, planPush } from "../src/index.js";
import { BASE, COMMIT, FakeRunner, WT, healthy, makeDeps, sub } from "./helpers.js";

const input = { worktree: WT, remote: "origin", branch: "axis/feat", baseSha: BASE };

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof GitOpsError, String(e));
    return e.code;
  }
  return "OK";
}

test("the refspec is exactly refs/heads/axis/<slug>:refs/heads/axis/<slug>, after --", async () => {
  const plan = await planPush(makeDeps(new FakeRunner(healthy())), input);
  assert.equal(plan.refspec, "refs/heads/axis/feat:refs/heads/axis/feat");
  const s = sub(plan.command.argv);
  assert.deepEqual(s.slice(-3), ["--", "origin", "refs/heads/axis/feat:refs/heads/axis/feat"]);
  assert.equal(plan.command.context, "pty");
  assert.equal(plan.command.env["GIT_TERMINAL_PROMPT"], "0");
  for (const bad of ["--force", "--mirror", "--all", "--tags", "--delete", "--force-with-lease"]) assert.equal(s.includes(bad), false);
  assert.ok(s.includes("--no-follow-tags"));
});

test("isAllowedRefspec refuses force, wildcard, tag, delete and mismatched refspecs", () => {
  assert.ok(isAllowedRefspec("refs/heads/axis/feat:refs/heads/axis/feat"));
  for (const bad of [
    "+refs/heads/axis/feat:refs/heads/axis/feat",
    "refs/heads/axis/*:refs/heads/axis/*",
    "refs/tags/v1:refs/tags/v1",
    ":refs/heads/axis/feat",
    "refs/heads/axis/feat",
    "refs/heads/axis/feat:refs/heads/main",
    "refs/heads/main:refs/heads/axis/feat",
    "refs/heads/axis/feat:refs/heads/axis/other",
    "refs/heads/axis/feat:refs/heads/axis/feat ",
    "refs/heads/axis/-x:refs/heads/axis/-x",
    "",
  ]) assert.equal(isAllowedRefspec(bad), false, bad);
});

test("only axis/<slug> branches are pushed; option-like and odd names are refused", async () => {
  for (const b of ["main", "axis/", "axis/Feat", "axis/-x", "--upload-pack=x", "-f", "axis/a b", "axis/a..b", "refs/heads/axis/feat", "axis/feat/sub", "+axis/feat", "axis/feat:main", "axis/a*"]) {
    const c = await code(planPush(makeDeps(new FakeRunner(healthy())), { ...input, branch: b }));
    assert.ok(c === "E_POLICY_DENIED" || c === "E_INVALID_ARGUMENT", `${b}: ${c}`);
  }
});

test("the remote must be a configured name: URLs, options and unknown names are refused", async () => {
  for (const r of ["https://github.com/o/r", "git@github.com:o/r.git", "-u", "--receive-pack=x", "origin/x", "", "ext::sh -c x", "o rigin", "../x", "/tmp/r"]) {
    assert.equal(await code(planPush(makeDeps(new FakeRunner(healthy())), { ...input, remote: r })), "E_INVALID_ARGUMENT", r);
  }
  assert.equal(await code(planPush(makeDeps(new FakeRunner(healthy())), { ...input, remote: "upstream" })), "E_INVALID_ARGUMENT");
});

test("a remote whose push URL embeds credentials, or uses ext::, is refused and the password never appears", async () => {
  const cred = new FakeRunner(healthy((s) => (s[0] === "remote" && s[1] === "get-url" ? { stdout: "https://user:hunter2@github.com/o/r.git\n" } : undefined)));
  try {
    await planPush(makeDeps(cred), input);
    assert.fail("expected a refusal");
  } catch (e) {
    assert.ok(e instanceof GitOpsError);
    assert.equal(e.code, "E_POLICY_DENIED");
    assert.ok(!e.message.includes("hunter2"));
  }
  const ext = new FakeRunner(healthy((s) => (s[0] === "remote" && s[1] === "get-url" ? { stdout: "ext::sh -c evil\n" } : undefined)));
  assert.equal(await code(planPush(makeDeps(ext), input)), "E_POLICY_DENIED");
});

test("L24: a push is refused while a CLI run is active", async () => {
  const r = new FakeRunner(healthy());
  assert.equal(await code(planPush(makeDeps(r, { isCliRunActive: () => true }), input)), "E_POLICY_DENIED");
  assert.equal(r.calls.length, 0);
});

test("GIT-SNAP-1 is re-taken before the push and a drift refuses it; the pty runner is never called", async () => {
  const order: string[] = [];
  const r = new FakeRunner(healthy((s, req) => { order.push(req.context === "pty" ? "push" : s[0] as string); return undefined; }));
  const deps = makeDeps(r, { assertNoDrift: async () => { order.push("drift"); } });
  await executePush(deps, input);
  assert.ok(order.indexOf("drift") < order.indexOf("push"));
  const drifted = new FakeRunner(healthy());
  const bad = makeDeps(drifted, { assertNoDrift: async () => { throw new GitOpsError("E_POLICY_DENIED", "drift"); } });
  assert.equal(await code(executePush(bad, input)), "E_POLICY_DENIED");
  assert.equal(drifted.ptyCalls().length, 0);
});

test("the worktree must be on the branch being pushed", async () => {
  const r = new FakeRunner(healthy((s) => (s[0] === "symbolic-ref" ? { stdout: "axis/other\n" } : undefined)));
  assert.equal(await code(planPush(makeDeps(r), input)), "E_POLICY_DENIED");
});

test("--no-verify and an empty hooks path only when hooks are off", async () => {
  const on = await planPush(makeDeps(new FakeRunner(healthy()), { runHooks: true }), input);
  assert.equal(on.command.argv.includes("--no-verify"), false);
  assert.equal(on.command.argv.some((a) => a.includes("hooksPath")), false);
  const off = await planPush(makeDeps(new FakeRunner(healthy()), { runHooks: false }), input);
  assert.ok(off.command.argv.includes("--no-verify"));
  assert.ok(off.command.argv.includes("core.hooksPath=/dev/null"));
});

test("PSH-1 warn mode: findings need confirmation; names only", async () => {
  const scanner = async () => [{ rule: "aws-key", path: ".env", line: 3 }];
  const r = new FakeRunner(healthy());
  const deps = makeDeps(r, { scanner, scanMode: "warn" });
  const plan = await planPush(deps, input);
  assert.equal(plan.requiresConfirmation, true);
  assert.deepEqual(plan.findings, [{ rule: "aws-key", path: ".env", line: 3, commit: COMMIT }]);
  assert.equal(await code(executePush(deps, input)), "E_APPROVAL_REQUIRED");
  assert.equal(r.ptyCalls().length, 0);
  await executePush(deps, input, { confirmed: true });
  assert.equal(r.ptyCalls().length, 1);
});

test("PSH-1 refuse mode refuses without naming the secret; the scanner sees the diff", async () => {
  let seen = "";
  const scanner = async (d: string) => { seen = d; return [{ rule: "private-key" }]; };
  const deps = makeDeps(new FakeRunner(healthy()), { scanner, scanMode: "refuse" });
  assert.equal(await code(planPush(deps, input)), "E_POLICY_DENIED");
  assert.equal(seen, "+hello\n");
});

test("the secret-scan diff uses no external diff or textconv, and no findings means no confirmation", async () => {
  const r = new FakeRunner(healthy());
  const plan = await planPush(makeDeps(r, { scanner: async () => [] }), input);
  assert.equal(plan.requiresConfirmation, false);
  const diff = r.calls.find((c) => sub(c.argv)[0] === "diff-tree");
  assert.ok(diff);
  assert.ok(sub(diff.argv).includes("--no-ext-diff") && sub(diff.argv).includes("--no-textconv"));
});

test("S-1: the scan runs from the journaled baseSha and never reads a ref under refs/remotes", async () => {
  const r = new FakeRunner(healthy());
  await planPush(makeDeps(r, { scanner: async () => [] }), input);
  const diff = r.calls.find((c) => sub(c.argv)[0] === "diff-tree");
  const range = r.calls.find((c) => sub(c.argv)[0] === "rev-list");
  assert.ok(diff && range && sub(range.argv).includes(`^${BASE}`));
  assert.equal(r.calls.some((c) => c.argv.some((a) => a.includes("refs/remotes"))), false);
});

test("S-1: a missing, malformed or non-ancestor base is refused", async () => {
  const mk = (over: Record<string, unknown>) => planPush(makeDeps(new FakeRunner(healthy())), { ...input, ...over } as typeof input);
  assert.equal(await code(mk({ baseSha: undefined })), "E_INVALID_ARGUMENT");
  assert.equal(await code(mk({ baseSha: "main" })), "E_INVALID_ARGUMENT");
  assert.equal(await code(mk({ baseSha: "A".repeat(40) })), "E_INVALID_ARGUMENT");
  const missing = new FakeRunner(healthy((s) => (s[0] === "rev-parse" && s.includes(`${BASE}^{commit}`) ? { code: 1 } : undefined)));
  assert.equal(await code(planPush(makeDeps(missing), input)), "E_CONFLICT");
  const rewritten = new FakeRunner(healthy((s) => (s[0] === "merge-base" ? { code: 1 } : undefined)));
  assert.equal(await code(planPush(makeDeps(rewritten), input)), "E_CONFLICT");
});

test("B-3: the scanner is called once per outgoing commit, oldest first, with the commit in its meta", async () => {
  const C1 = "1".repeat(40);
  const C2 = "2".repeat(40);
  const r = new FakeRunner(healthy((s) => (s[0] === "rev-list" ? { stdout: `${C1}\n${C2}\n` } : s[0] === "diff-tree" ? { stdout: `+patch of ${s.at(-1)}\n` } : undefined)));
  const calls: Array<[string, string]> = [];
  await planPush(makeDeps(r, { scanner: async (d, meta) => { calls.push([meta.commit, d]); return []; } }), input);
  assert.deepEqual(calls, [[C1, `+patch of ${C1}\n`], [C2, `+patch of ${C2}\n`]]);
  const range = r.calls.find((c) => sub(c.argv)[0] === "rev-list");
  assert.ok(range && sub(range.argv).includes("--reverse"));
  const patch = r.calls.find((c) => sub(c.argv)[0] === "diff-tree");
  assert.ok(patch);
  for (const flag of ["-p", "-m", "--no-ext-diff", "--no-textconv", "--submodule=short"]) assert.ok(sub(patch.argv).includes(flag), flag);
});

test("S-2: the patch is taken with --text and binary paths are parsed from numstat", async () => {
  const stat = (s: string[]) => (s[0] === "diff-tree" && s.includes("--numstat") ? { stdout: "-\t-\tkey.p12\0" + "1\t0\ta.txt\0" } : undefined);
  const r = new FakeRunner(healthy(stat));
  const metas: string[][] = [];
  const plan = await planPush(makeDeps(r, { scanner: async (_d, m) => { metas.push([...m.binaryPaths]); return []; }, scanMode: "warn" }), input);
  assert.deepEqual(metas, [["key.p12"]]);
  assert.equal(plan.requiresConfirmation, true);
  const patch = r.calls.find((c) => sub(c.argv)[0] === "diff-tree" && !sub(c.argv).includes("--numstat"));
  assert.ok(patch && sub(patch.argv).includes("--text"));
  const statCall = r.calls.find((c) => sub(c.argv).includes("--numstat"));
  assert.ok(statCall && !sub(statCall.argv).includes("--text"), "numstat must not use --text or git would count binary files as text");
});
