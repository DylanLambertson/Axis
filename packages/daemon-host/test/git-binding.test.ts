// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import { DaemonError, type Handler } from "@axis/daemon";
import { GitOpsError, ScanIncomplete, type GitRunRequest, type GitRunResult } from "@axis/git-ops";
import { SecretScanError, createSecretScanner } from "@axis/secret-scan";
import { MAX_PUSH_FINDINGS, gitPushPlanResponseSchema } from "@axis/protocol";
import { createGitOperations, createGitPort, gitFailure, pushPlanReply, registerGitHandlers, toGitError, type HandlerRegistrar } from "../src/index.js";
import { gitRig, gitUnavailable } from "./git-rig.js";
import { createWs, gitSkipReason, worktreesRig } from "./worktrees-rig.js";

const SKIP = gitUnavailable();
const scanner = createSecretScanner({ mode: "refuse" });
const base = {
  gitPath: path.resolve("/definitely/not/used/git"),
  env: { daemon: {}, pty: {} },
  platform: process.platform,
  runHooks: false,
  assertNoDrift: async (): Promise<void> => undefined,
};
const req = (context: string): GitRunRequest => ({ argv: ["--version"], cwd: path.resolve("/"), env: {}, context: context as "pty" });

test("the git port takes its scanner and its mode from one value, and refuses a missing or modeless scanner", async () => {
  assert.equal(createGitPort({ ...base, scanner }).scanMode, "refuse");
  assert.equal(createGitPort({ ...base, scanner: createSecretScanner({ mode: "warn" }) }).scanMode, "warn");
  // The port's scanner is the scanner's own `scan` (wrapped only to tell an incomplete scan from a failure): same findings.
  const meta = { worktree: { workTree: path.resolve("/"), gitDir: path.resolve("/.git") }, truncated: false, commit: "a".repeat(40), binaryPaths: [], allowedBinaryPaths: [], part: "patch" as const };
  const text = `+aws = ${["AKIA", "ABCDEFGHIJKLMNOP"].join("")}\n`;
  assert.deepEqual(await createGitPort({ ...base, scanner }).scanner?.(text, meta), await scanner.scan(text, meta));
  assert.ok((await scanner.scan(text, meta)).length > 0);
  assert.throws(() => createGitPort({ ...base } as never), TypeError);
  assert.throws(() => createGitPort({ ...base, scanner: { scan: scanner.scan, limits: scanner.limits } } as never), TypeError);
  assert.throws(() => createGitPort({ ...base, scanner: { ...scanner, mode: "off" } } as never), TypeError);
});

test("the git port's runner routes by context: pty only to the pty runner, never to the node runner, and an unknown context or a missing pty runner is refused", async () => {
  const seen: string[] = [];
  const ptyRunner = { run: async (r: GitRunRequest): Promise<GitRunResult> => (seen.push(r.context), { code: 0, stdout: "", stderr: "" }) };
  const port = createGitPort({ ...base, scanner, ptyRunner });
  assert.equal((await port.runner.run(req("pty"))).code, 0);
  assert.deepEqual(seen, ["pty"]);
  // A daemon-context request goes to the node runner (the absent git path fails there), never to the pty runner.
  await assert.rejects(port.runner.run(req("daemon")));
  assert.deepEqual(seen, ["pty"]);
  for (const context of ["", "PTY", "other"]) {
    await assert.rejects(port.runner.run(req(context)), (e: unknown) => e instanceof GitOpsError && e.code === "E_UNAVAILABLE", context);
  }
  const none = createGitPort({ ...base, scanner });
  await assert.rejects(none.runner.run(req("pty")), (e: unknown) => e instanceof GitOpsError && e.code === "E_UNAVAILABLE");
  assert.deepEqual(seen, ["pty"]);
});

test("the git operations refuse a port without a scanner and a mode, and expose the mode the scan runs with", () => {
  const port = createGitPort({ ...base, scanner });
  const runs = { hasActiveRun: () => false };
  assert.equal(createGitOperations({ git: port, runs }).scanMode, "refuse");
  const { scanner: _s, ...noScanner } = port;
  const { scanMode: _m, ...noMode } = port;
  for (const git of [noScanner, noMode, { ...port, scanMode: "off" }, { ...port, scanner: "scan" }]) {
    assert.throws(() => createGitOperations({ git: git as never, runs }), TypeError);
  }
});

test("axis.git/1 is not registered without the scan mode of its operations, and nothing is registered when it refuses", () => {
  const registered: string[] = [];
  const registrar: HandlerRegistrar = { register: (c) => void registered.push(c) };
  for (const scanMode of [undefined, "off", "", 1]) {
    assert.throws(() => registerGitHandlers(registrar, { ops: { scanMode } } as never), /secret scanner/);
  }
  assert.deepEqual(registered, []);
});

test("axis.git/1 registers four handlers with a content hook for push only, through the registrar", () => {
  const seen: Array<{ methods: string[]; content: string[] }> = [];
  const registrar: HandlerRegistrar = { register: (_c, _v, handlers: Readonly<Record<string, Handler>>, o) => void seen.push({ methods: Object.keys(handlers).sort(), content: Object.keys(o?.content ?? {}) }) };
  registerGitHandlers(registrar, { ops: { scanMode: "warn" } } as never);
  assert.deepEqual(seen, [{ methods: ["commit", "compareUrl", "push", "pushPlan"], content: ["push"] }]);
});

test("compareUrl: the compare URL of the remote's own URL, with the workspace's base and branch", { skip: SKIP ?? false }, async (t) => {
  const r = await gitRig();
  t.after(() => r.cleanup());
  const c = await r.connect();
  r.git("remote", "add", "gh", "https://github.com/octo/repo.git");
  const url = await c.rpc("axis.git", "compareUrl", { workspaceId: r.workspaceId, remote: "gh" });
  assert.deepEqual(url.result, { url: "https://github.com/octo/repo/compare/main...axis/feat" });
  const other = await c.rpc("axis.git", "compareUrl", { workspaceId: r.workspaceId, remote: "gh", base: "release/1" });
  assert.deepEqual(other.result, { url: "https://github.com/octo/repo/compare/release/1...axis/feat" });
  // A remote that is not configured, one that is not GitHub, and one with embedded credentials: closed errors that echo nothing.
  r.git("remote", "add", "elsewhere", "https://example.invalid/octo/repo.git");
  r.git("remote", "add", "leaky", `https://user:${["pass", "word"].join("")}@github.com/octo/repo.git`);
  for (const remote of ["missing", "elsewhere", "leaky", "origin"]) {
    const res = await c.rpc("axis.git", "compareUrl", { workspaceId: r.workspaceId, remote });
    assert.equal(res.error?.code, "E_INVALID_ARGUMENT", remote);
    const text = JSON.stringify(res.error);
    assert.ok(!text.includes("example.invalid") && !text.includes("password") && !text.includes(r.root), remote);
  }
  assert.equal((await c.rpc("axis.git", "compareUrl", { workspaceId: "nope", remote: "gh" })).error?.code, "E_NOT_FOUND");
});

test("the worktrees binding exposes the GIT-SNAP-1 re-take for the git port, and a drifted git configuration refuses it", { skip: gitSkipReason() }, async (t) => {
  const r = await worktreesRig();
  t.after(() => r.cleanup());
  const user = await r.connect();
  const { id } = await createWs(user, (_m, x) => (assert.equal(x.ok, true, JSON.stringify(x.error)), x));
  const workTree = String(r.journal.getWorkspace(id)?.worktreePath);
  await r.binding.assertNoDrift({ workTree });
  r.git(r.repo, "config", "core.hooksPath", path.join(r.tmp, "hooks"));
  await assert.rejects(r.binding.assertNoDrift({ workTree }), (e: unknown) => e instanceof DaemonError && e.details?.["reason"] === "git_drift");
});

test("a refusal is a code of the closed set with a fixed text: no reason outside the contract, no text of the cause", () => {
  assert.equal(toGitError(new Error("fatal: /home/x/secret/path")).code, "E_INTERNAL");
  assert.equal(toGitError(new Error("fatal: /home/x"), AbortSignal.abort()).code, "E_CANCELLED");
  const e = gitFailure("E_CONFLICT", "stale");
  assert.deepEqual([e.code, e.details], ["E_CONFLICT", { reason: "stale" }]);
  assert.equal(gitFailure("E_CONFLICT", "free text /home/x").details, undefined);
  const own = new DaemonError("E_NOT_FOUND", "kept");
  assert.equal(toGitError(own), own);
});

const facts = (over: Record<string, unknown> = {}) => ({ tip: "a".repeat(40), digest: "b".repeat(64), requiresConfirmation: true, reasons: ["one"], findings: [{ rule: "aws-access-key-id", path: "x.txt", line: 1, commit: "c".repeat(40) }], ...over });

test("pushPlanReply escapes paths and reasons, bounds the lists and refuses a plan the contract cannot carry", () => {
  const bidi = "a‮b.txt";
  const ok = pushPlanReply(facts({ findings: [{ rule: "scan-incomplete", path: bidi }], reasons: [`binary: ${bidi}`] }) as never, "origin", "axis/feat");
  assert.ok(ok);
  assert.ok(!JSON.stringify(ok).includes("‮"), "escaped, not forwarded");
  assert.equal(gitPushPlanResponseSchema.safeParse(ok).success, true);
  // A rule the contract cannot carry is renamed, a commit that is not an object id is dropped; the finding still counts.
  const odd = pushPlanReply(facts({ findings: [{ rule: "has space", commit: "short", line: -1 }] }) as never, "origin", "axis/feat");
  assert.deepEqual(odd?.findings, [{ rule: "unrecognised-rule" }]);
  const many = Array.from({ length: MAX_PUSH_FINDINGS + 5 }, () => ({ rule: "generic-secret-assignment" }));
  const big = pushPlanReply(facts({ findings: many }) as never, "origin", "axis/feat");
  assert.equal(big?.findings.length, MAX_PUSH_FINDINGS);
  assert.equal(big?.findingsTruncated, true);
  assert.equal(pushPlanReply(facts({ findings: many.slice(0, 3) }) as never, "origin", "axis/feat")?.findingsTruncated, false);
  const reasons = pushPlanReply(facts({ reasons: Array.from({ length: 12 }, (_, i) => `r${i}`) }) as never, "origin", "axis/feat");
  assert.equal(reasons?.reasons.length, 8);
  // Not a plan: no confirmation asked although there are reasons, a bad tip, a bad branch.
  assert.equal(pushPlanReply(facts({ requiresConfirmation: false }) as never, "origin", "axis/feat"), null);
  assert.equal(pushPlanReply(facts({ tip: "zz" }) as never, "origin", "axis/feat"), null);
  assert.equal(pushPlanReply(facts() as never, "origin", "feat"), null);
});

test("executePush sends only the confirmed plan: a tip or digest that is not the current plan is plan_changed and nothing is pushed", { skip: SKIP ?? false }, async (t) => {
  const r = await gitRig();
  t.after(() => r.cleanup());
  r.write("a.txt", "x\n");
  r.git("add", "-A");
  r.git("commit", "-q", "-m", "x");
  const call = { workspaceId: r.workspaceId, worktree: { workTree: r.repo, gitDir: path.join(r.repo, ".git") }, remote: "origin", branch: "axis/feat", baseSha: r.baseSha };
  const plan = await r.handlerDeps.ops.planPush(call);
  for (const wrong of [{ tip: r.baseSha, digest: plan.digest }, { tip: plan.tip, digest: "f".repeat(64) }]) {
    await assert.rejects(r.handlerDeps.ops.executePush(call, wrong), (e: unknown) => (e as { code?: string; reason?: string }).code === "E_CONFLICT" && (e as { reason?: string }).reason === "plan_changed");
  }
  assert.equal(r.remoteTip(), null);
  await r.handlerDeps.ops.executePush(call, { tip: plan.tip, digest: plan.digest });
  assert.equal(r.remoteTip(), plan.tip);
});

test("the port's scanner reports an incomplete scan as ScanIncomplete and leaves a scanner failure and any other throw as they are", async () => {
  const meta = { worktree: { workTree: path.resolve("/"), gitDir: path.resolve("/.git") }, truncated: false, commit: "a".repeat(40), binaryPaths: [], allowedBinaryPaths: [], part: "patch" as const };
  const thrower = (e: unknown) => {
    const scan = createGitPort({ ...base, scanner: { ...scanner, scan: async () => Promise.reject(e) } }).scanner;
    assert.ok(scan !== undefined);
    return (text: string) => scan(text, meta);
  };
  for (const code of ["too_large", "deadline", "budget"] as const) await assert.rejects(thrower(new SecretScanError(code))("x"), ScanIncomplete, code);
  const internal = new SecretScanError("internal");
  await assert.rejects(thrower(internal)("x"), (e: unknown) => e === internal);
  const other = new Error("boom");
  await assert.rejects(thrower(other)("x"), (e: unknown) => e === other);
});

test("a drift refusal other than git_drift, and a DaemonError git_drift only, reach git-ops as they are or as the closed conflict", async () => {
  const drift = (e: unknown) => createGitPort({ ...base, scanner, assertNoDrift: () => Promise.reject(e) }).assertNoDrift({ workTree: path.resolve("/"), gitDir: path.resolve("/.git") });
  await assert.rejects(drift(new DaemonError("E_CONFLICT", "leaky /home/x", { reason: "git_drift" })), (e: unknown) => e instanceof GitOpsError && e.code === "E_CONFLICT" && e.details?.["reason"] === "git_drift" && !e.message.includes("/home/x"));
  const plain = new DaemonError("E_CONFLICT", "other", { reason: "not_drift" });
  await assert.rejects(drift(plain), (e: unknown) => e === plain);
  const raw = new Error("x");
  await assert.rejects(drift(raw), (e: unknown) => e === raw);
});
