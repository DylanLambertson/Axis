// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { GitOpsError, MAX_COMMITS, MAX_DIFF, executePush, isAllowedRefspec, planPush } from "../src/index.js";
import { BASE, COMMIT, FakeRunner, HEAD, WT, healthy, makeDeps, sub } from "./helpers.js";

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

test("the refspec is exactly <scanned tip>:refs/heads/axis/<slug>, after --", async () => {
  const plan = await planPush(makeDeps(new FakeRunner(healthy())), input);
  assert.equal(plan.refspec, `${HEAD}:refs/heads/axis/feat`);
  assert.equal(plan.tip, HEAD);
  const s = sub(plan.command.argv);
  assert.deepEqual(s.slice(-3), ["--", "origin", `${HEAD}:refs/heads/axis/feat`]);
  assert.equal(plan.command.context, "pty");
  assert.equal(plan.command.env["GIT_TERMINAL_PROMPT"], "0");
  for (const bad of ["--force", "--mirror", "--all", "--tags", "--delete", "--force-with-lease"]) assert.equal(s.includes(bad), false);
  assert.ok(s.includes("--no-follow-tags"));
});

test("isAllowedRefspec accepts only an object id into refs/heads/axis/<slug>", () => {
  assert.ok(isAllowedRefspec(`${HEAD}:refs/heads/axis/feat`));
  assert.ok(isAllowedRefspec(`${"c".repeat(64)}:refs/heads/axis/feat`));
  for (const bad of [
    `+${HEAD}:refs/heads/axis/feat`,
    "refs/heads/axis/feat:refs/heads/axis/feat",
    "refs/heads/axis/*:refs/heads/axis/*",
    `${HEAD}:refs/tags/v1`,
    `${HEAD}:refs/heads/main`,
    `${HEAD}:refs/heads/axis/-x`,
    `${HEAD}:refs/heads/axis/feat `,
    `${"c".repeat(39)}:refs/heads/axis/feat`,
    `${"C".repeat(40)}:refs/heads/axis/feat`,
    `HEAD:refs/heads/axis/feat`,
    ":refs/heads/axis/feat",
    HEAD,
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

test("S-8: a patch past the size limit fails closed: refused in refuse mode, confirmation in warn mode", async () => {
  const big = "+x\n".repeat(MAX_DIFF);
  const runner = () => new FakeRunner(healthy((s) => (s[0] === "diff-tree" && !s.includes("--numstat") ? { stdout: big } : undefined)));
  const flags: boolean[] = [];
  const scanner = async (d: string, m: { truncated: boolean }) => { flags.push(m.truncated); assert.equal(d.length, MAX_DIFF); return []; };
  const refused = await code(planPush(makeDeps(runner(), { scanner, scanMode: "refuse" }), input));
  assert.equal(refused, "E_POLICY_DENIED");
  const plan = await planPush(makeDeps(runner(), { scanner, scanMode: "warn" }), input);
  assert.equal(plan.requiresConfirmation, true);
  assert.match(plan.reasons.join(), /too large to scan/);
  assert.deepEqual(flags, [true, true]);
  assert.equal(await code(executePush(makeDeps(runner(), { scanner, scanMode: "warn" }), input)), "E_APPROVAL_REQUIRED");
});

test("S-8: more commits than the scan limit fails closed too", async () => {
  const many = Array.from({ length: MAX_COMMITS + 1 }, (_, i) => i.toString(16).padStart(40, "0")).join("\n");
  const r = new FakeRunner(healthy((s) => (s[0] === "rev-list" ? { stdout: many } : undefined)));
  let calls = 0;
  const deps = makeDeps(r, { scanner: async () => { calls += 1; return []; }, scanMode: "refuse" });
  assert.equal(await code(planPush(deps, input)), "E_POLICY_DENIED");
  assert.equal(calls, MAX_COMMITS);
});

test("S-3: a branch that moved after the scan is refused before the push, and the pty runner is never called", async () => {
  const MOVED = "f".repeat(40);
  let reads = 0;
  // The branch ref is read once while planning; only the re-check immediately before the push sees it has moved.
  const r = new FakeRunner(healthy((s) => {
    if (s[0] === "rev-parse" && s.includes("refs/heads/axis/feat^{commit}") && (reads += 1) > 1) return { stdout: `${MOVED}\n` };
    return undefined;
  }));
  assert.equal(await code(executePush(makeDeps(r), input)), "E_CONFLICT");
  assert.equal(r.ptyCalls().length, 0);
});

test("S-7: remote helpers and unlisted transports are refused; https, ssh, git, scp and local paths are accepted", async () => {
  const urlRunner = (u: string) => new FakeRunner(healthy((s) => (s[0] === "remote" && s[1] === "get-url" ? { stdout: `${u}\n` } : undefined)));
  for (const bad of ["foo::bar", "ext::sh -c x", "fd::3", "http://github.com/o/r.git", "ftp://h/r", "git+ssh://h/r", "FOO://h/r", "rsync://h/r"]) {
    assert.equal(await code(planPush(makeDeps(urlRunner(bad)), input)), "E_POLICY_DENIED", bad);
  }
  for (const ok of ["https://github.com/o/r.git", "ssh://git@github.com/o/r.git", "git://h/r.git", "git@github.com:o/r.git", "/srv/git/r.git", "file:///srv/git/r.git", "HTTPS://github.com/o/r"]) {
    assert.equal(await code(planPush(makeDeps(urlRunner(ok)), input)), "OK", ok);
  }
});

test("S-7: the pty push carries a protocol allow-list that refuses everything but https, ssh, git and file", async () => {
  const plan = await planPush(makeDeps(new FakeRunner(healthy())), input);
  const pairs = plan.command.argv.flatMap((a, i, all) => (all[i - 1] === "-c" && a.startsWith("protocol.") ? [a] : []));
  assert.deepEqual(pairs.filter((p) => p !== "protocol.ext.allow=never"), [
    "protocol.allow=never", "protocol.https.allow=always", "protocol.ssh.allow=always", "protocol.git.allow=always", "protocol.file.allow=always",
  ]);
  assert.ok(plan.command.argv.indexOf("protocol.allow=never") < plan.command.argv.indexOf("push"));
});
