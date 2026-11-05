// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Ticket P1e: a scan that blocks a push is shown (closed reason, rule names, display paths) and refused with a closed reason.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import { DaemonError } from "@axis/daemon";
import { GIT_PUSH_BLOCKS, MAX_BLOCKED_BINARY_PATHS, gitPushPlanResponseSchema } from "@axis/protocol";
import { pushPlanReply } from "../src/index.js";
import { gitRig, gitUnavailable, type GitClient, type GitRig, type GitRigOptions } from "./git-rig.js";

const SKIP = gitUnavailable();
/** Assembled at runtime so no credential-shaped literal sits in this file. */
const CANARY = ["AKIA", "ABCDEFGHIJKLMNOP"].join("");
type Blocked = { reason: string; binaryPaths: string[]; binaryPathsTruncated: boolean };
type Plan = { tip: string; digest: string; requiresConfirmation: boolean; reasons: string[]; findings: Array<Record<string, unknown>>; blocked?: Blocked };

async function setup(t: TestContext, options: GitRigOptions = {}): Promise<{ r: GitRig; c: GitClient }> {
  const r = await gitRig(options);
  t.after(() => r.cleanup());
  return { r, c: await r.connect("user") };
}
const commitFile = (r: GitRig, name: string, data: string | Buffer, ...flags: string[]): string => {
  r.write(name, data);
  r.git("add", "-A");
  r.git(...flags, "commit", "-q", "-m", `add ${name}`);
  return r.head();
};
const plan = (c: GitClient, r: GitRig, extra: Record<string, unknown> = {}) => c.rpc("axis.git", "pushPlan", { workspaceId: r.workspaceId, remote: "origin", ...extra });
const planOf = async (c: GitClient, r: GitRig, extra: Record<string, unknown> = {}): Promise<Plan> => {
  const res = await plan(c, r, extra);
  assert.equal(res.ok, true, JSON.stringify(res.error));
  return res.result as unknown as Plan;
};
const push = (c: GitClient, r: GitRig, p: Plan, extra: Record<string, unknown> = {}) =>
  c.rpc("axis.git", "push", { workspaceId: r.workspaceId, remote: "origin", confirmedPlan: { tip: p.tip, digest: p.digest }, ...extra }, randomUUID());
const noLeak = (r: GitRig, m: unknown): void => {
  const text = JSON.stringify(m);
  assert.ok(!text.includes(r.root), "no path");
  assert.ok(!text.includes("remote.git"));
  assert.ok(!text.includes(CANARY), "no matched text");
};
/** A refused push: a closed `E_CONFLICT` reason, before any challenge, native confirmation or pty command, and nothing on the remote. */
async function assertRefused(r: GitRig, c: GitClient, p: Plan, reason: string, extra: Record<string, unknown> = {}): Promise<void> {
  const before = r.ptyCalls.length;
  const res = await push(c, r, p, extra);
  assert.equal(res.error?.code, "E_CONFLICT", JSON.stringify(res.error));
  assert.equal((res.error?.details as { reason?: string } | undefined)?.reason, reason);
  assert.equal(r.supervisor.filter((m) => m["type"] === "native.confirm").length, 0, "no challenge was confirmed");
  assert.equal(r.ptyCalls.length, before, "nothing ran in the pty context");
  assert.equal(r.calls.executePush, 0);
  assert.equal(r.remoteTip(), null);
  noLeak(r, res);
}

test("refuse mode, a finding: pushPlan is blocked secrets_found with the rule and path, push is refused with the same closed reason", { skip: SKIP ?? false }, async (t) => {
  const { r, c } = await setup(t, { scanMode: "refuse" });
  const tip = commitFile(r, "cfg.txt", `aws_id = ${CANARY}\n`);
  const res = await plan(c, r);
  noLeak(r, res);
  const p = res.result as unknown as Plan;
  assert.deepEqual(p.blocked, { reason: "secrets_found", binaryPaths: [], binaryPathsTruncated: false });
  assert.deepEqual(p.findings.map((f) => [f["rule"], f["path"], f["commit"]]), [["aws-access-key-id", "cfg.txt", tip]]);
  assert.deepEqual([p.requiresConfirmation, p.reasons], [false, []]);
  await assertRefused(r, c, p, "secrets_found");
  // The reason also comes back when the request names a digest nobody saw: the block is decided before the plan is compared.
  await assertRefused(r, c, { ...p, digest: "a".repeat(64) }, "secrets_found");
});

test("refuse mode, an incomplete scan: blocked scan_incomplete, and push is refused scan_incomplete", { skip: SKIP ?? false }, async (t) => {
  const { r, c } = await setup(t, { scanMode: "refuse", maxBytes: 8 });
  commitFile(r, "a.txt", "some text that is longer than eight bytes\n");
  const p = await planOf(c, r);
  assert.equal(p.blocked?.reason, "scan_incomplete");
  assert.equal(p.requiresConfirmation, false);
  await assertRefused(r, c, p, "scan_incomplete");
});

test("refuse mode, a binary file: blocked binary_unscanned listing the path; allowing exactly that path unblocks plan and push; other paths stay blocked", { skip: SKIP ?? false }, async (t) => {
  const { r, c } = await setup(t, { scanMode: "refuse" });
  commitFile(r, "img/logo.bin", Buffer.from([0x89, 0x50, 0, 1, 2, 0, 3]));
  const p = await planOf(c, r);
  assert.deepEqual(p.blocked, { reason: "binary_unscanned", binaryPaths: ["img/logo.bin"], binaryPathsTruncated: false });
  await assertRefused(r, c, p, "binary_unscanned");
  const other = await planOf(c, r, { allowedBinaryPaths: ["img/other.bin"] });
  assert.deepEqual(other.blocked?.binaryPaths, ["img/logo.bin"], "an unrelated path allows nothing");
  await assertRefused(r, c, other, "binary_unscanned", { allowedBinaryPaths: ["img/other.bin"] });
  // The allowed plan is a plan like any other: no block, and the tier 4 flow is reached (a challenge, not a refusal).
  const ok = await planOf(c, r, { allowedBinaryPaths: ["img/logo.bin"] });
  assert.equal(ok.blocked, undefined);
  const first = await push(c, r, ok, { allowedBinaryPaths: ["img/logo.bin"] });
  assert.equal(first.error?.code, "E_APPROVAL_REQUIRED", JSON.stringify(first.error));
});

test("blocked binary paths are escaped, bounded and the truncation is said; a secret and a binary file together report the first reason and both lists", { skip: SKIP ?? false }, async (t) => {
  const { r, c } = await setup(t, { scanMode: "refuse" });
  for (let i = 0; i < MAX_BLOCKED_BINARY_PATHS + 2; i++) r.write(`bin/${String(i).padStart(3, "0")}.bin`, Buffer.from([0, i]));
  r.write("odd‮name.bin", Buffer.from([0, 9]));
  r.write("cfg.txt", `aws_id = ${CANARY}\n`);
  r.git("add", "-A");
  r.git("commit", "-q", "-m", "many");
  const p = await planOf(c, r);
  assert.equal(p.blocked?.reason, "secrets_found", "findings come before binary files");
  assert.equal(p.blocked?.binaryPaths.length, MAX_BLOCKED_BINARY_PATHS);
  assert.equal(p.blocked?.binaryPathsTruncated, true);
  assert.ok(p.blocked?.binaryPaths.every((x) => !/[‮\u0000-\u001f]/.test(x)));
  assert.ok(p.findings.some((f) => f["path"] === "cfg.txt"));
  noLeak(r, p);
  const odd = await planOf(c, r, { allowedBinaryPaths: Array.from({ length: MAX_BLOCKED_BINARY_PATHS }, (_, i) => `bin/${String(i).padStart(3, "0")}.bin`) });
  assert.ok(odd.blocked !== undefined && odd.blocked.binaryPaths.length >= 1);
  assert.ok(odd.blocked.binaryPaths.some((x) => x.includes("odd\\u{202e}name.bin")), JSON.stringify(odd.blocked.binaryPaths));
});

test("a commit message nothing can read: blocked message_unscannable in refuse and in warn mode, and push is refused", { skip: SKIP ?? false }, async (t) => {
  for (const scanMode of ["refuse", "warn"] as const) {
    const { r, c } = await setup(t, { scanMode });
    commitFile(r, "a.txt", "x\n", "-c", "i18n.commitEncoding=x-not-an-encoding");
    const p = await planOf(c, r);
    assert.equal(p.blocked?.reason, "message_unscannable", scanMode);
    assert.equal(p.requiresConfirmation, false, scanMode);
    await assertRefused(r, c, p, "message_unscannable");
  }
});

test("warn mode is unchanged: findings, binary files and an incomplete scan need confirmation and are never blocked", { skip: SKIP ?? false }, async (t) => {
  const a = await setup(t, { scanMode: "warn" });
  commitFile(a.r, "cfg.txt", `aws_id = ${CANARY}\n`);
  commitFile(a.r, "img/logo.bin", Buffer.from([0, 1, 2]));
  const p = await planOf(a.c, a.r);
  assert.equal(p.blocked, undefined);
  assert.equal(p.requiresConfirmation, true);
  assert.ok(p.reasons.length > 0 && p.findings.some((f) => f["rule"] === "aws-access-key-id"));
  noLeak(a.r, p);
  const first = await push(a.c, a.r, p);
  assert.equal(first.error?.code, "E_APPROVAL_REQUIRED", "the challenge is reached");
  const b = await setup(t, { scanMode: "warn", maxBytes: 8 });
  commitFile(b.r, "a.txt", "some text that is longer than eight bytes\n");
  const w = await planOf(b.c, b.r);
  assert.equal(w.blocked, undefined);
  assert.equal(w.requiresConfirmation, true);
});

test("git_drift: a drifted git configuration is E_CONFLICT with the closed reason on pushPlan and push; another failure of the check is not", { skip: SKIP ?? false }, async (t) => {
  let fail: () => Error = () => new DaemonError("E_CONFLICT", "drift text with /private/path", { reason: "git_drift" });
  const { r, c } = await setup(t, { assertNoDrift: () => Promise.reject(fail()) });
  const tip = commitFile(r, "a.txt", "x\n");
  const res = await plan(c, r);
  assert.equal(res.error?.code, "E_CONFLICT");
  assert.equal((res.error?.details as { reason?: string }).reason, "git_drift");
  assert.ok(!JSON.stringify(res.error).includes("/private/path"));
  await assertRefused(r, c, { tip, digest: "a".repeat(64) } as Plan, "git_drift");
  fail = () => new DaemonError("E_CONFLICT", "other", { reason: "something_else" });
  const other = await plan(c, r);
  assert.equal(other.error?.code, "E_UNAVAILABLE", JSON.stringify(other.error));
  assert.equal((other.error?.details as { reason?: string } | undefined)?.reason, undefined);
  fail = () => new Error("boom /secret/place");
  const boom = await plan(c, r);
  assert.equal(boom.error?.code, "E_UNAVAILABLE");
  assert.ok(!JSON.stringify(boom.error).includes("/secret/place"));
});

test("pushPlanReply: a blocked plan keeps only the closed reason, display-safe paths and at most the cap; anything else fails closed", () => {
  const facts = { tip: "a".repeat(40), digest: "b".repeat(64), requiresConfirmation: false, reasons: [], findings: [] };
  const paths = Array.from({ length: MAX_BLOCKED_BINARY_PATHS + 5 }, (_, i) => `p${i}‮.bin`);
  const reply = pushPlanReply({ ...facts, blocked: { reason: "binary_unscanned", binaryPaths: paths } }, "origin", "axis/feat");
  assert.ok(reply?.blocked !== undefined);
  assert.equal(reply.blocked.binaryPaths.length, MAX_BLOCKED_BINARY_PATHS);
  assert.equal(reply.blocked.binaryPathsTruncated, true);
  assert.equal(reply.blocked.binaryPaths[0], "p0\\u{202e}.bin");
  assert.equal(gitPushPlanResponseSchema.safeParse(reply).success, true);
  for (const reason of GIT_PUSH_BLOCKS) assert.equal(pushPlanReply({ ...facts, blocked: { reason, binaryPaths: [] } }, "origin", "axis/feat")?.blocked?.reason, reason);
  for (const reason of ["plan_changed", "git_drift", "", "secrets", "/home/me/secret"]) assert.equal(pushPlanReply({ ...facts, blocked: { reason, binaryPaths: [] } }, "origin", "axis/feat"), null, reason);
  // A block that also asks for confirmation is not a plan the contract carries.
  assert.equal(pushPlanReply({ ...facts, requiresConfirmation: true, reasons: ["r"], blocked: { reason: "secrets_found", binaryPaths: [] } }, "origin", "axis/feat"), null);
  assert.equal(pushPlanReply(facts, "origin", "axis/feat")?.blocked, undefined);
});
