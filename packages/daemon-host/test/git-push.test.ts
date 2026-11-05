// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { Policy } from "@axis/daemon";
import { GitRefusal, PushedBases } from "../src/index.js";
import { gitRig, gitUnavailable, type GitClient, type GitRig, type GitRigOptions } from "./git-rig.js";

const SKIP = gitUnavailable();
const allowAll: Policy = { evaluate: () => ({ effect: "allow" }) };
/** Assembled at runtime so no credential-shaped literal sits in this file. */
const CANARY = ["AKIA", "ABCDEFGHIJKLMNOP"].join("");

async function setup(t: TestContext, options: GitRigOptions = {}, actor = "user"): Promise<{ r: GitRig; c: GitClient }> {
  const r = await gitRig(options);
  t.after(() => r.cleanup());
  return { r, c: await r.connect(actor) };
}
const commitFile = (r: GitRig, name: string, text: string): string => {
  r.write(name, text);
  r.git("add", "-A");
  r.git("commit", "-q", "-m", `add ${name}`);
  return r.head();
};
type Plan = { tip: string; digest: string; requiresConfirmation: boolean; reasons: string[]; findings: Array<Record<string, unknown>> };
async function plan(c: GitClient, r: GitRig, extra: Record<string, unknown> = {}) {
  return c.rpc("axis.git", "pushPlan", { workspaceId: r.workspaceId, remote: "origin", ...extra });
}
const confirmed = (p: Plan) => ({ tip: p.tip, digest: p.digest });
const pushReq = (r: GitRig, p: { tip: string; digest: string }, extra: Record<string, unknown> = {}) => ({ workspaceId: r.workspaceId, remote: "origin", confirmedPlan: p, ...extra });
const noLeak = (r: GitRig, m: { error?: unknown; result?: unknown }): void => {
  const text = JSON.stringify([m.error, m.result]);
  assert.ok(!text.includes(r.root), "no path");
  assert.ok(!text.includes("remote.git"));
  assert.ok(!text.includes(CANARY), "no matched text");
};

/** The whole tier 4 flow: the challenge, the user's approval, the native confirmation and the retry with the approval. */
async function pushOnce(r: GitRig, c: GitClient, p: { tip: string; digest: string }, key = randomUUID(), extra: Record<string, unknown> = {}) {
  const first = await c.rpc("axis.git", "push", pushReq(r, p, extra), key);
  assert.equal(first.error?.code, "E_APPROVAL_REQUIRED", JSON.stringify(first.error));
  const ch = (first.error?.details as { challenge: { challengeId: string; digest: string } }).challenge;
  const resolved = await c.rpc("axis.approvals", "resolve", { challengeId: ch.challengeId, decision: "approve", digest: ch.digest });
  assert.equal(resolved.ok, true, JSON.stringify(resolved.error));
  await r.confirmNative(ch.challengeId);
  const end = Date.now() + 5000;
  while (r.approvals.stats().native.entries !== 0) {
    if (Date.now() > end) assert.fail("native confirmation not applied");
    await new Promise((x) => setTimeout(x, 5));
  }
  return c.rpc("axis.git", "push", pushReq(r, p, { ...extra, approval: { challengeId: ch.challengeId } }), key);
}

test("pushPlan: the tip of the workspace's branch, no findings, and the plan is bound by a digest; nothing is pushed", { skip: SKIP ?? false }, async (t) => {
  const { r, c } = await setup(t);
  const tip = commitFile(r, "a.txt", "hello\n");
  const res = await plan(c, r);
  assert.equal(res.ok, true, JSON.stringify(res.error));
  const p = res.result as unknown as Plan & { remote: string; branch: string };
  assert.equal(p.tip, tip);
  assert.equal(p.branch, "axis/feat");
  assert.equal(p.remote, "origin");
  assert.deepEqual([p.requiresConfirmation, p.reasons, p.findings], [false, [], []]);
  assert.match(p.digest, /^[0-9a-f]{64}$/);
  assert.equal(r.remoteTip(), null);
  noLeak(r, res);
});

test("pushPlan: the scan base is the recorded base until something was pushed to THAT remote, then the pushed tip", { skip: SKIP ?? false }, async (t) => {
  const { r, c } = await setup(t);
  commitFile(r, "a.txt", "one\n");
  await plan(c, r);
  assert.equal(r.calls.planPush.at(-1)?.baseSha, r.baseSha);
  assert.equal(r.calls.planPush.at(-1)?.branch, "axis/feat", "the branch is the journal's");
  // A sha the journal records is the workspace's, not a remote's: it is not a base for any push.
  const first = r.head();
  r.journal.recordPushed(r.workspaceId, first, "user");
  commitFile(r, "b.txt", "two\n");
  await plan(c, r);
  assert.equal(r.calls.planPush.at(-1)?.baseSha, r.baseSha, "never a base for a remote nothing was pushed to");
});

test("a secret confirmed and pushed to one remote is still scanned, and shown, for another remote", { skip: SKIP ?? false }, async (t) => {
  const { r, c } = await setup(t, { scanMode: "warn" });
  const mirror = join(r.root, "mirror.git");
  r.git("init", "-q", "--bare", mirror);
  r.git("remote", "add", "mirror", mirror);
  commitFile(r, "cfg.txt", `aws_id = ${CANARY}\n`);
  const p = (await plan(c, r)).result as unknown as Plan;
  assert.equal(p.requiresConfirmation, true);
  assert.equal((await pushOnce(r, c, confirmed(p))).ok, true);
  commitFile(r, "clean.txt", "nothing here\n");
  // origin: scanned from what origin has, so only the clean commit and no finding.
  const origin = (await plan(c, r)).result as unknown as Plan;
  assert.deepEqual([origin.requiresConfirmation, origin.findings], [false, []]);
  assert.equal(r.calls.planPush.at(-1)?.baseSha, p.tip);
  // mirror has none of it: the whole range is scanned and the finding is shown again.
  const other = (await plan(c, r, { remote: "mirror" })).result as unknown as Plan;
  assert.equal(other.requiresConfirmation, true);
  assert.deepEqual(other.findings.map((f) => f["rule"]), ["aws-access-key-id"]);
  assert.equal(r.calls.planPush.at(-1)?.baseSha, r.baseSha);
  // And the push to mirror is bound to that plan: the plan that was clean for origin is not a plan for mirror.
  const stale = await c.rpc("axis.git", "push", pushReq(r, confirmed(origin), { remote: "mirror" }), randomUUID());
  assert.equal(stale.error?.details?.["reason"], "plan_changed");
  assert.throws(() => r.git("--git-dir", mirror, "rev-parse", "--verify", "refs/heads/axis/feat"));
});

test("the push that went out and then failed to answer is retried as a no-op push, not a second one", { skip: SKIP ?? false }, async (t) => {
  let boom = true;
  const { r, c } = await setup(t, {
    ops: (real) => ({
      ...real,
      executePush: async (call, conf) => {
        await real.executePush(call, conf);
        if (boom) {
          boom = false;
          throw new GitRefusal("E_UNAVAILABLE");
        }
      },
    }),
  });
  const tip = commitFile(r, "a.txt", "hello\n");
  const p = (await plan(c, r)).result as unknown as Plan;
  const first = await pushOnce(r, c, confirmed(p));
  assert.equal(first.error?.code, "E_UNAVAILABLE");
  assert.equal(r.remoteTip(), tip, "it went out");
  // The key was freed and the approval spent: the user confirms again, and the same plan is a no-op push.
  const again = await pushOnce(r, c, confirmed(p));
  assert.equal(again.ok, true, JSON.stringify(again.error));
  assert.equal(r.remoteTip(), tip);
  assert.equal(r.git("--no-pager", "--git-dir", r.remote, "rev-list", "--count", "refs/heads/axis/feat").trim(), "2");
  const next = (await plan(c, r)).result as unknown as Plan;
  assert.equal(r.calls.planPush.at(-1)?.baseSha, tip);
  assert.equal(next.requiresConfirmation, false);
});

test("secret path (warn mode): a finding by rule and path only, confirmation is required, and the matched text is never shown", { skip: SKIP ?? false }, async (t) => {
  const { r, c } = await setup(t, { scanMode: "warn" });
  const tip = commitFile(r, "cfg.txt", `aws_id = ${CANARY}\n`);
  const res = await plan(c, r);
  assert.equal(res.ok, true, JSON.stringify(res.error));
  const p = res.result as unknown as Plan;
  assert.equal(p.requiresConfirmation, true);
  assert.deepEqual(p.findings.map((f) => [f["rule"], f["path"], f["commit"]]), [["aws-access-key-id", "cfg.txt", tip]]);
  assert.ok(p.reasons.length > 0);
  noLeak(r, res);
});

test("secret path (refuse mode): the plan is refused with a fixed error that does not echo the text", { skip: SKIP ?? false }, async (t) => {
  const { r, c } = await setup(t, { scanMode: "refuse" });
  commitFile(r, "cfg.txt", `aws_id = ${CANARY}\n`);
  const res = await plan(c, r);
  // The plan comes back blocked (git-push-blocked.test.ts), never as a plan to confirm and never as a bare error.
  assert.equal(res.ok, true, JSON.stringify(res.error));
  assert.equal((res.result as { blocked?: { reason: string } }).blocked?.reason, "secrets_found");
  noLeak(r, res);
  // The push is refused before any challenge: nothing for the user to confirm.
  const push = await c.rpc("axis.git", "push", pushReq(r, { tip: r.head(), digest: "a".repeat(64) }), randomUUID());
  assert.equal(push.error?.code, "E_CONFLICT");
  assert.equal((push.error?.details as { reason?: string } | undefined)?.reason, "secrets_found");
  assert.equal(r.supervisor.filter((m) => m["type"] === "native.confirm").length, 0);
  noLeak(r, push);
});

test("an incomplete scan fails closed: refused in refuse mode, a finding that needs confirmation in warn mode", { skip: SKIP ?? false }, async (t) => {
  const refuse = await setup(t, { scanMode: "refuse", maxBytes: 8 });
  commitFile(refuse.r, "a.txt", "some text that is longer than eight bytes\n");
  const res = await plan(refuse.c, refuse.r);
  assert.equal(res.ok, true, JSON.stringify(res.error));
  assert.equal((res.result as { blocked?: { reason: string }; requiresConfirmation: boolean }).blocked?.reason, "scan_incomplete", "never a clean plan");
  assert.equal((res.result as { requiresConfirmation: boolean }).requiresConfirmation, false);
  noLeak(refuse.r, res);
  const warn = await setup(t, { scanMode: "warn", maxBytes: 8 });
  commitFile(warn.r, "a.txt", "some text that is longer than eight bytes\n");
  const w = await plan(warn.c, warn.r);
  assert.equal(w.ok, true, JSON.stringify(w.error));
  const p = w.result as unknown as Plan;
  assert.equal(p.requiresConfirmation, true);
  assert.ok(p.findings.some((f) => f["rule"] === "scan-incomplete"));
});

test("push: challenge, approval, native confirmation, then the scanned tip is on the remote and recorded as the last pushed sha", { skip: SKIP ?? false }, async (t) => {
  const { r, c } = await setup(t);
  const tip = commitFile(r, "a.txt", "hello\n");
  const p = (await plan(c, r)).result as unknown as Plan;
  const res = await pushOnce(r, c, confirmed(p));
  assert.equal(res.ok, true, JSON.stringify(res.error));
  assert.deepEqual(res.result, { remote: "origin", branch: "axis/feat", tip });
  assert.equal(r.remoteTip(), tip);
  assert.equal(r.journal.getWorkspace(r.workspaceId)?.lastPushedSha, tip);
  assert.ok(r.ptyCalls.length > 0 && r.ptyCalls.every((x) => x === "pty"), "the push ran through the pty runner only");
  // The next plan scans from what was pushed.
  commitFile(r, "b.txt", "more\n");
  await plan(c, r);
  assert.equal(r.calls.planPush.at(-1)?.baseSha, tip);
  // The second push (its hook, twice, and its handler) plans from the recorded sha as well, never from the base again.
  const second = (await plan(c, r)).result as unknown as Plan;
  const before = r.calls.planPush.length;
  assert.equal((await pushOnce(r, c, confirmed(second))).ok, true);
  const planned = r.calls.planPush.slice(before);
  assert.ok(planned.length >= 2 && planned.every((x) => x.baseSha === tip), JSON.stringify(planned));
});

test("push on a stalled anchor: refused with anchor_stalled before any scan and before any challenge", { skip: SKIP ?? false }, async (t) => {
  const { r, c } = await setup(t);
  commitFile(r, "a.txt", "hello\n");
  const p = (await plan(c, r)).result as unknown as Plan;
  const scans = r.calls.planPush.length;
  r.gate.stalled = true;
  const res = await c.rpc("axis.git", "push", pushReq(r, confirmed(p)), randomUUID());
  assert.equal(res.error?.code, "E_UNAVAILABLE");
  assert.equal(res.error?.details?.["reason"], "anchor_stalled");
  assert.equal(r.calls.planPush.length, scans, "the stalled host did not even scan");
  assert.equal(r.supervisor.filter((m) => m["type"] === "native.confirm").length, 0);
  assert.equal(r.approvals.port.pending("w1").length, 0, "no challenge exists");
  // Reads keep working while it is stalled, and the push works once the anchor resumes.
  assert.equal((await plan(c, r)).ok, true);
  r.gate.stalled = false;
  assert.equal((await pushOnce(r, c, confirmed(p))).ok, true);
});

test("an anchor that stalls after the approval refuses the spend: nothing is pushed", { skip: SKIP ?? false }, async (t) => {
  const { r, c } = await setup(t);
  commitFile(r, "a.txt", "hello\n");
  const p = (await plan(c, r)).result as unknown as Plan;
  const key = randomUUID();
  const first = await c.rpc("axis.git", "push", pushReq(r, confirmed(p)), key);
  const ch = (first.error?.details as { challenge: { challengeId: string; digest: string } }).challenge;
  await c.rpc("axis.approvals", "resolve", { challengeId: ch.challengeId, decision: "approve", digest: ch.digest });
  await r.confirmNative(ch.challengeId);
  while (r.approvals.stats().native.entries !== 0) await new Promise((x) => setTimeout(x, 5));
  r.gate.stalled = true;
  const res = await c.rpc("axis.git", "push", pushReq(r, confirmed(p), { approval: { challengeId: ch.challengeId } }), key);
  assert.equal(res.error?.details?.["reason"], "anchor_stalled");
  assert.equal(r.remoteTip(), null);
  assert.equal(r.calls.executePush, 0);
});

test("a plan that changed since it was shown is plan_changed before a challenge exists, and after one nothing is pushed", { skip: SKIP ?? false }, async (t) => {
  const { r, c } = await setup(t);
  commitFile(r, "a.txt", "hello\n");
  const p = (await plan(c, r)).result as unknown as Plan;
  const newer = commitFile(r, "b.txt", "later\n");
  const res = await c.rpc("axis.git", "push", pushReq(r, confirmed(p)), randomUUID());
  assert.equal(res.error?.code, "E_CONFLICT");
  assert.equal(res.error?.details?.["reason"], "plan_changed");
  assert.equal(r.supervisor.filter((m) => m["type"] === "native.confirm").length, 0, "no challenge for a stale plan");
  assert.equal(r.remoteTip(), null);
  // Changed between the user's approval and the retry: refused, nothing sent.
  const fresh = (await plan(c, r)).result as unknown as Plan;
  const key = randomUUID();
  const first = await c.rpc("axis.git", "push", pushReq(r, confirmed(fresh)), key);
  const ch = (first.error?.details as { challenge: { challengeId: string; digest: string } }).challenge;
  await c.rpc("axis.approvals", "resolve", { challengeId: ch.challengeId, decision: "approve", digest: ch.digest });
  await r.confirmNative(ch.challengeId);
  while (r.approvals.stats().native.entries !== 0) await new Promise((x) => setTimeout(x, 5));
  commitFile(r, "c.txt", "after approval\n");
  const late = await c.rpc("axis.git", "push", pushReq(r, confirmed(fresh), { approval: { challengeId: ch.challengeId } }), key);
  assert.equal(late.ok, false);
  assert.equal(late.error?.code, "E_CONFLICT");
  assert.equal(r.remoteTip(), null);
  assert.equal(newer.length, 40);
});

test("if recording the pushed sha fails after the push went out, the reply is still the success and the key stays used", { skip: SKIP ?? false }, async (t) => {
  const { r, c } = await setup(t, { recordPushedFails: true });
  const tip = commitFile(r, "a.txt", "hello\n");
  const p = (await plan(c, r)).result as unknown as Plan;
  const key = randomUUID();
  const res = await pushOnce(r, c, confirmed(p), key);
  assert.equal(res.ok, true, JSON.stringify(res.error));
  assert.equal(r.remoteTip(), tip);
  assert.equal(r.gate.bookkeeping.length, 1, "the failure was reported");
  assert.equal(r.journal.getWorkspace(r.workspaceId)?.lastPushedSha, null, "the journal write failed; the in-memory base still knows the push");
});

test("a push the remote refuses is a fixed error, records nothing and leaks no path", { skip: SKIP ?? false }, async (t) => {
  const { r, c } = await setup(t);
  commitFile(r, "a.txt", "hello\n");
  // The remote already has another history on that branch: a non-fast-forward push is rejected.
  r.git("push", "-q", "origin", `${r.baseSha}:refs/heads/axis/feat`);
  const other = r.git("commit-tree", "-m", "other", `${r.baseSha}^{tree}`).trim();
  r.git("push", "-q", "-f", "origin", `${other}:refs/heads/axis/feat`);
  const p = (await plan(c, r)).result as unknown as Plan;
  const res = await pushOnce(r, c, confirmed(p));
  assert.equal(res.ok, false);
  assert.equal(res.error?.code, "E_UNAVAILABLE");
  assert.equal(r.journal.getWorkspace(r.workspaceId)?.lastPushedSha, null);
  noLeak(r, res);
  assert.equal(r.remoteTip(), other);
});

test("push: a live run in the workspace refuses it before a challenge exists", { skip: SKIP ?? false }, async (t) => {
  const { r, c } = await setup(t);
  commitFile(r, "a.txt", "hello\n");
  const p = (await plan(c, r)).result as unknown as Plan;
  r.gate.runsActive = true;
  assert.equal((await plan(c, r)).error?.code, "E_CONFLICT", "the plan is refused too: a run may still be writing");
  const res = await c.rpc("axis.git", "push", pushReq(r, confirmed(p)), randomUUID());
  assert.equal(res.error?.code, "E_CONFLICT");
  assert.equal(r.supervisor.filter((m) => m["type"] === "native.confirm").length, 0);
});

test("only the user pushes or plans, whatever the policy allows", { skip: SKIP ?? false }, async (t) => {
  const { r, c } = await setup(t, { policy: allowAll }, "agent:planner");
  commitFile(r, "a.txt", "hello\n");
  const res = await plan(c, r);
  assert.equal(res.error?.code, "E_NOT_FOUND");
  const push = await c.rpc("axis.git", "push", pushReq(r, { tip: r.head(), digest: "a".repeat(64) }), randomUUID());
  assert.equal(push.error?.code, "E_NOT_FOUND");
  assert.equal(r.calls.planPush.length, 0);
  assert.equal(r.supervisor.filter((m) => m["type"] === "native.confirm").length, 0);
});

test("git refusals map to the closed error set: no text, no unknown reason, POLICY_DENIED is a conflict", { skip: SKIP ?? false }, async (t) => {
  const reasons: Array<[GitRefusal, string, unknown]> = [
    [new GitRefusal("E_POLICY_DENIED", "detached_head"), "E_CONFLICT", "detached_head"],
    [new GitRefusal("E_POLICY_DENIED", "not in the set /home/x"), "E_CONFLICT", undefined],
    [new GitRefusal("E_CONFLICT", "plan_changed"), "E_CONFLICT", "plan_changed"],
    [new GitRefusal("E_POLICY_DENIED", "secrets_found"), "E_CONFLICT", "secrets_found"],
    [new GitRefusal("E_POLICY_DENIED", "scan_incomplete"), "E_CONFLICT", "scan_incomplete"],
    [new GitRefusal("E_POLICY_DENIED", "binary_unscanned"), "E_CONFLICT", "binary_unscanned"],
    [new GitRefusal("E_POLICY_DENIED", "message_unscannable"), "E_CONFLICT", "message_unscannable"],
    [new GitRefusal("E_CONFLICT", "git_drift"), "E_CONFLICT", "git_drift"],
    [new GitRefusal("E_INVALID_ARGUMENT", "too_large"), "E_INVALID_ARGUMENT", "too_large"],
    [new GitRefusal("E_APPROVAL_REQUIRED"), "E_INTERNAL", undefined],
    [new GitRefusal("E_SOMETHING_ELSE"), "E_UNAVAILABLE", undefined],
  ];
  for (const [refusal, code, reason] of reasons) {
    const { r, c } = await setup(t, { ops: (real) => ({ ...real, planPush: async () => { throw refusal; } }) });
    commitFile(r, "a.txt", "x\n");
    const res = await plan(c, r);
    assert.equal(res.error?.code, code, String(refusal.code));
    assert.equal(res.error?.details?.["reason"], reason);
    assert.ok(!JSON.stringify(res.error).includes("/home"));
  }
});

test("an error that is no refusal is E_INTERNAL with a fixed text on the wire and is reported to the host", { skip: SKIP ?? false }, async (t) => {
  const { r, c } = await setup(t, { ops: (real) => ({ ...real, planPush: async () => { throw new Error("fatal: /home/x/secret"); } }) });
  commitFile(r, "a.txt", "x\n");
  const res = await plan(c, r);
  assert.equal(res.error?.code, "E_INTERNAL");
  assert.ok(!JSON.stringify(res.error).includes("/home"));
  assert.equal(r.gate.internal.length, 1);
});

test("a remote re-pointed after a push is scanned from the base again, and two names for one URL share what was pushed", { skip: SKIP ?? false }, async (t) => {
  const { r, c } = await setup(t, { scanMode: "warn" });
  const other = join(r.root, "other.git");
  r.git("init", "-q", "--bare", other);
  commitFile(r, "cfg.txt", `aws_id = ${CANARY}\n`);
  const p = (await plan(c, r)).result as unknown as Plan;
  assert.equal((await pushOnce(r, c, confirmed(p))).ok, true);
  commitFile(r, "clean.txt", "nothing here\n");
  assert.equal(((await plan(c, r)).result as unknown as Plan).requiresConfirmation, false);
  // A second name for the SAME destination shares the entry: nothing new to scan there either.
  r.git("remote", "add", "alias", r.remote);
  assert.equal(((await plan(c, r, { remote: "alias" })).result as unknown as Plan).requiresConfirmation, false);
  assert.equal(r.calls.planPush.at(-1)?.baseSha, p.tip);
  // The same name now points elsewhere: what was confirmed for the old URL says nothing about this one.
  r.git("remote", "set-url", "origin", other);
  const moved = (await plan(c, r)).result as unknown as Plan;
  assert.equal(moved.requiresConfirmation, true);
  assert.deepEqual(moved.findings.map((f) => f["rule"]), ["aws-access-key-id"]);
  assert.equal(r.calls.planPush.at(-1)?.baseSha, r.baseSha);
  // A push-only URL counts too.
  r.git("remote", "set-url", "--push", "alias", other);
  assert.equal(((await plan(c, r, { remote: "alias" })).result as unknown as Plan).requiresConfirmation, true);
});

test("a push the remote refuses records no base: the next plan still scans from the recorded base", { skip: SKIP ?? false }, async (t) => {
  const { r, c } = await setup(t);
  commitFile(r, "a.txt", "hello\n");
  r.git("push", "-q", "origin", `${r.baseSha}:refs/heads/axis/feat`);
  const other = r.git("commit-tree", "-m", "other", `${r.baseSha}^{tree}`).trim();
  r.git("push", "-q", "-f", "origin", `${other}:refs/heads/axis/feat`);
  const p = (await plan(c, r)).result as unknown as Plan;
  assert.equal((await pushOnce(r, c, confirmed(p))).ok, false);
  await plan(c, r);
  assert.equal(r.calls.planPush.at(-1)?.baseSha, r.baseSha);
});

test("PushedBases is bounded (the oldest entry is forgotten and falls back to the recorded base) and refuses a bad bound", () => {
  const b = new PushedBases(2);
  b.record("w", "t1", "a".repeat(40));
  b.record("w", "t2", "b".repeat(40));
  b.record("w", "t3", "c".repeat(40));
  assert.equal(b.size, 2);
  assert.equal(b.baseFor("w", "t1", "base"), "base");
  assert.equal(b.baseFor("w", "t3", "base"), "c".repeat(40));
  assert.equal(b.baseFor("other", "t3", "base"), "base", "per workspace");
  for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) assert.throws(() => new PushedBases(bad), RangeError);
});
