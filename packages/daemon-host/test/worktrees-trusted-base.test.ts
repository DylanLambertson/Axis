// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { test, type TestContext } from "node:test";
import * as path from "node:path";
import { DaemonError } from "@axis/daemon";
import { finaliseApproved, createWs as createWsRaw, gitSkipReason, worktreesRig, type Rig, type RigOptions } from "./worktrees-rig.js";

const skip = gitSkipReason();
const createWs = (user: Parameters<typeof createWsRaw>[0], name?: string, over: Record<string, unknown> = {}) =>
  createWsRaw(user, (_m, x) => (assert.equal(x.ok, true, JSON.stringify(x.error)), x), name, over);
const dirOf = (r: Rig, id: string): string => String(r.journal.getWorkspace(id)?.worktreePath);
const svc = { caller: { actor: "user", connectionId: "c", windowId: "w" }, signal: new AbortController().signal };
const metaFile = (r: Rig, id: string): string => {
  const dir = path.join(r.repo, ".git", "worktrees");
  const name = readdirSync(dir).find((n) => readFileSync(path.join(dir, n, "axis-workspace.json"), "utf8").includes(id)) as string;
  return path.join(dir, name, "axis-workspace.json");
};

async function rig(t: TestContext, over: RigOptions = {}) {
  const r = await worktreesRig(over);
  t.after(() => r.cleanup());
  return { r, user: await r.connect() };
}
/** A workspace with a commit that is NOT in main, and a second branch that does hold it (what a run could arrange). */
async function unmerged(t: TestContext, over: RigOptions = {}, createOver: Record<string, unknown> = {}) {
  const { r, user } = await rig(t, over);
  const { id } = await createWs(user, undefined, createOver);
  r.git(dirOf(r, id), "commit", "-q", "--allow-empty", "-m", "work not in main");
  r.git(r.repo, "branch", "evil", r.git(dirOf(r, id), "rev-parse", "HEAD").trim());
  return { r, user, id };
}

test("create records the resolved base branch in the journal, and nothing when the base is a commit", { skip }, async (t) => {
  const { r, user } = await rig(t);
  const a = await createWs(user);
  const main = r.git(r.repo, "symbolic-ref", "HEAD").trim();
  assert.equal(r.journal.getWorkspace(a.id)?.baseBranch, main);
  const sha = r.git(r.repo, "rev-parse", "HEAD").trim();
  const b = await createWs(user, "pinned to a commit", { baseRef: sha });
  assert.equal(r.journal.getWorkspace(b.id)?.baseBranch, null);
});

test("merged: a run that rewrites the manager's record cannot make an unmerged workspace look merged", { skip }, async (t) => {
  const { r, user, id } = await unmerged(t);
  const file = metaFile(r, id);
  const meta = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  writeFileSync(file, JSON.stringify({ ...meta, baseBranch: "refs/heads/evil" }));
  const res = await finaliseApproved(r, user, id, "merged");
  assert.equal(res.error?.code, "E_CONFLICT");
  assert.deepEqual(res.error?.details, { reason: "not_merged" });
  assert.equal(r.journal.getWorkspace(id)?.state, "READY");
});

test("merged: a run that moves the shared HEAD cannot make an unmerged workspace look merged (normal finalise)", { skip }, async (t) => {
  const { r, user, id } = await unmerged(t);
  r.git(r.repo, "symbolic-ref", "HEAD", "refs/heads/evil");
  const res = await finaliseApproved(r, user, id, "merged");
  assert.equal(res.error?.code, "E_CONFLICT");
  assert.equal(r.journal.getWorkspace(id)?.state, "READY");
});

test("merged: the repair of an interrupted finalise ignores the shared HEAD and the manager's record", { skip }, async (t) => {
  const state = { fail: false };
  const { r, user, id } = await unmerged(t, { failAudit: (e) => state.fail && e.action === "worktree.finalise" && (e.payload as { phase?: string }).phase === "done" });
  state.fail = true;
  assert.equal((await finaliseApproved(r, user, id, "abandoned")).ok, false);
  state.fail = false;
  await r.binding.service.reconcile(new AbortController().signal);
  // Both things a finished run can write point at a branch that holds the commit ...
  r.git(r.repo, "symbolic-ref", "HEAD", "refs/heads/evil");
  const file = metaFile(r, id);
  const meta = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  writeFileSync(file, JSON.stringify({ ...meta, baseBranch: "refs/heads/evil" }));
  await assert.rejects(r.binding.service.finalise({ id, outcome: "merged" }, svc), (e: unknown) => e instanceof DaemonError && e.details?.["reason"] === "not_merged");
  assert.equal(r.journal.getWorkspace(id)?.state, "READY");
  // ... and the journal's base is still the real one: the honest outcome completes it.
  assert.equal((await r.binding.service.finalise({ id, outcome: "abandoned" }, svc)).state, "FINALISED");
});

test("merged fails closed when the journal holds no base branch (a base that was a commit, or a workspace from before the record)", { skip }, async (t) => {
  const state = { fail: false };
  const { r, user } = await rig(t, { failAudit: (e) => state.fail && e.action === "worktree.finalise" && (e.payload as { phase?: string }).phase === "done" });
  const head = r.git(r.repo, "rev-parse", "HEAD").trim();
  const { id } = await createWs(user, undefined, { baseRef: head });
  assert.equal(r.journal.getWorkspace(id)?.baseBranch, null);
  // The tip IS an ancestor of main, so only the missing record can be what refuses it.
  const res = await finaliseApproved(r, user, id, "merged");
  assert.equal(res.error?.code, "E_CONFLICT");
  assert.deepEqual(res.error?.details, { reason: "no_base_branch" });
  assert.equal(r.journal.getWorkspace(id)?.state, "READY");
  // The same on the repair path.
  state.fail = true;
  assert.equal((await finaliseApproved(r, user, id, "abandoned")).ok, false);
  state.fail = false;
  await r.binding.service.reconcile(new AbortController().signal);
  await assert.rejects(r.binding.service.finalise({ id, outcome: "merged" }, svc), (e: unknown) => e instanceof DaemonError && e.details?.["reason"] === "not_merged");
});

test("merged still works when the recorded base holds the commit", { skip }, async (t) => {
  const { r, user } = await rig(t);
  const { id } = await createWs(user);
  const tip = (): string => r.git(dirOf(r, id), "rev-parse", "HEAD").trim();
  r.git(dirOf(r, id), "commit", "-q", "--allow-empty", "-m", "work");
  assert.equal((await finaliseApproved(r, user, id, "merged")).error?.details?.["reason"], "not_merged");
  r.git(r.repo, "merge", "-q", "--ff-only", tip());
  assert.equal((await finaliseApproved(r, user, id, "merged")).ok, true);
  assert.equal(r.journal.getWorkspace(id)?.finaliseOutcome, "merged");
});

/** What a finished run can do to the shared repository without moving the base branch ref. */
const forge = {
  replace(r: Rig, id: string): void {
    const tip = r.git(r.repo, "rev-parse", "main").trim();
    r.git(r.repo, "replace", tip, r.git(r.repo, "commit-tree", `${tip}^{tree}`, "-p", r.git(dirOf(r, id), "rev-parse", "HEAD").trim(), "-m", "x").trim());
  },
  graft(r: Rig, id: string): void {
    mkdirSync(path.join(r.repo, ".git", "info"), { recursive: true });
    writeFileSync(path.join(r.repo, ".git", "info", "grafts"), `${r.git(r.repo, "rev-parse", "main").trim()} ${r.git(dirOf(r, id), "rev-parse", "HEAD").trim()}\n`);
  },
  lookalike(r: Rig, id: string): void {
    r.git(r.repo, "update-ref", "refs/heads/refs/heads/main", r.git(dirOf(r, id), "rev-parse", "HEAD").trim());
    r.git(r.repo, "update-ref", "-d", "refs/heads/main");
  },
};

for (const [name, attack, reason] of [["a replace ref", forge.replace, "not_merged"], ["a graft file", forge.graft, "not_merged"], ["a lookalike ref", forge.lookalike, "no_base_branch"]] as const) {
  test(`merged: ${name} written by a run cannot make an unmerged workspace look merged (finalise and repair)`, { skip }, async (t) => {
    const state = { fail: false };
    const { r, user, id } = await unmerged(t, { failAudit: (e) => state.fail && e.action === "worktree.finalise" && (e.payload as { phase?: string }).phase === "done" });
    attack(r, id);
    const res = await finaliseApproved(r, user, id, "merged");
    assert.equal(res.error?.code, "E_CONFLICT", name);
    assert.deepEqual(res.error?.details, { reason }, name);
    assert.equal(r.journal.getWorkspace(id)?.state, "READY");
    // The repair path: git finalised, the journal did not; the same forgery must not be believed there either.
    state.fail = true;
    assert.equal((await finaliseApproved(r, user, id, "abandoned")).ok, false);
    state.fail = false;
    await r.binding.service.reconcile(new AbortController().signal);
    await assert.rejects(r.binding.service.finalise({ id, outcome: "merged" }, svc), (e: unknown) => e instanceof DaemonError && e.details?.["reason"] === "not_merged");
    assert.equal(r.journal.getWorkspace(id)?.state, "READY");
  });
}

test("merged: a rewritten manager record cannot stand in for a missing journal base", { skip }, async (t) => {
  const { r, user } = await rig(t);
  const head = r.git(r.repo, "rev-parse", "HEAD").trim();
  const { id } = await createWs(user, undefined, { baseRef: head });
  const file = metaFile(r, id);
  const meta = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  writeFileSync(file, JSON.stringify({ ...meta, baseBranch: "refs/heads/main" }));
  const res = await finaliseApproved(r, user, id, "merged");
  assert.deepEqual(res.error?.details, { reason: "no_base_branch" });
});

test("create audits the recorded base branch", { skip }, async (t) => {
  const { r, user } = await rig(t);
  const { id } = await createWs(user);
  const row = r.db.prepare("SELECT payload FROM audit_events WHERE action = 'worktree.create'").get() as { payload: string };
  assert.equal((JSON.parse(row.payload) as { baseBranch?: string }).baseBranch, r.journal.getWorkspace(id)?.baseBranch);
});
