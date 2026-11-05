// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { existsSync, lstatSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { test, type TestContext } from "node:test";
import * as path from "node:path";
import { DaemonError } from "@axis/daemon";
import { newKey, challengeOf, type Client } from "./approvals-rig.js";
import { approve4, waitFor } from "./approvals-helpers.js";
import { createWs as createWsRaw, finishedRun, gitSkipReason, worktreesRig, type Rig, type RigOptions } from "./worktrees-rig.js";

const skip = gitSkipReason();
const posix = process.platform === "win32" ? "symlinks" : undefined;
const WT = "axis.worktrees";
const createWs = (user: Client, name?: string) => createWsRaw(user, (_m, x) => (assert.equal(x.ok, true, JSON.stringify(x.error)), x), name);
const dirOf = (r: Rig, id: string): string => String(r.journal.getWorkspace(id)?.worktreePath);
const svc = { caller: { actor: "user", connectionId: "c", windowId: "w" }, signal: new AbortController().signal };
const live = new AbortController().signal;

async function twoWorkspaces(t: TestContext, options: RigOptions = {}) {
  const r = await worktreesRig(options);
  t.after(() => r.cleanup());
  const user = await r.connect();
  const a = (await createWs(user, "Alpha")).id;
  const b = (await createWs(user, "Bravo")).id;
  writeFileSync(path.join(dirOf(r, b), "a.txt"), "B unsaved work\n");
  return { r, user, a, b, runId: finishedRun(r, a) };
}
const bUntouched = (r: Rig, b: string): void => {
  assert.equal(readFileSync(path.join(dirOf(r, b), "a.txt"), "utf8"), "B unsaved work\n");
  assert.equal(r.git(r.repo, "for-each-ref", `refs/axis/backup/${b}`), "");
};

test("the manager backstop is reached: with the host's path check bypassed, a symlink into B is refused by the manager and B is untouched", { skip: skip ?? posix }, async (t) => {
  const { r, a, b, runId } = await twoWorkspaces(t, { testSeams: { restorePathCheck: async () => undefined } });
  symlinkSync(dirOf(r, b), path.join(dirOf(r, a), "link"));
  await assert.rejects(
    r.binding.service.restoreFromRunBase({ id: a, runId, paths: ["link/a.txt"] }, svc),
    (e: unknown) => e instanceof DaemonError && e.code === "E_CONFLICT",
  );
  bUntouched(r, b);
});

test("a symlink planted AFTER the host's check (a swap between check and call) is refused by the manager", { skip: skip ?? posix }, async (t) => {
  let plant: () => void = () => undefined;
  const { r, a, b, runId } = await twoWorkspaces(t, {
    testSeams: {
      wrapManager: (m) => ({ ...m, restoreFromRunBase: (input) => (plant(), m.restoreFromRunBase(input)) }),
    },
  });
  plant = () => symlinkSync(dirOf(r, b), path.join(dirOf(r, a), "swap"));
  await assert.rejects(r.binding.service.restoreFromRunBase({ id: a, runId, paths: ["swap/a.txt"] }, svc));
  // (the host check ran first and the path was not a link yet: only the manager could refuse it)
  bUntouched(r, b);
});

test("a symlink that stays inside the same workspace is refused by the manager's own parent check", { skip: skip ?? posix }, async (t) => {
  const { r, a, b, runId } = await twoWorkspaces(t, { testSeams: { restorePathCheck: async () => undefined } });
  const wa = dirOf(r, a);
  symlinkSync(path.join(wa, "sub"), path.join(wa, "alias")); // resolves inside A: only the symlink-component rule refuses it
  await assert.rejects(r.binding.service.restoreFromRunBase({ id: a, runId, paths: ["alias/b.txt"] }, svc), (e: unknown) => e instanceof DaemonError && e.code === "E_CONFLICT");
  assert.equal(readFileSync(path.join(wa, "sub", "b.txt"), "utf8"), "bravo\n");
  bUntouched(r, b);
});

test("a manager that reports a different spelling of the path: counted and audited before the check; refused on a case-sensitive file system, accepted on a case-insensitive one", { skip }, async (t) => {
  for (const insensitive of [false, true]) {
    const r = await worktreesRig({
      testSeams: {
        caseInsensitiveFs: insensitive,
        wrapManager: (m) => ({ ...m, restoreFromRunBase: async (i) => ({ ...(await m.restoreFromRunBase(i)), relPath: "A.TXT" }) }),
      },
    });
    t.after(() => r.cleanup());
    const user = await r.connect();
    const { id } = await createWs(user);
    const runId = finishedRun(r, id);
    writeFileSync(path.join(dirOf(r, id), "a.txt"), "edited\n");
    const res = await user.call(WT, "restoreFromRunBase", { id, runId, paths: ["a.txt"] }, newKey());
    assert.equal(res.ok, insensitive, JSON.stringify(res.error));
    assert.equal(readFileSync(path.join(dirOf(r, id), "a.txt"), "utf8"), "alpha\n", "the file was written");
    const audited = r.db.prepare("SELECT payload FROM audit_events WHERE action = 'worktree.restore'").all();
    assert.equal(audited.length, 1, "the write has its audit row either way");
  }
});

test("restore of a symlinked LEAF: the link is replaced by the file, never followed; a link to a directory is refused", { skip: skip ?? posix }, async (t) => {
  const { r, user, a, b, runId } = await twoWorkspaces(t);
  const wa = dirOf(r, a);
  const restore = (p: string) => user.call(WT, "restoreFromRunBase", { id: a, runId, paths: [p] }, newKey());
  // A run replaced a.txt with a link pointing INTO B: restoring must replace the link and leave B alone.
  rmSync(path.join(wa, "a.txt"));
  symlinkSync(path.join(dirOf(r, b), "a.txt"), path.join(wa, "a.txt"));
  const ok = await restore("a.txt");
  assert.equal(ok.ok, true, JSON.stringify(ok.error));
  assert.equal(lstatSync(path.join(wa, "a.txt")).isSymbolicLink(), false);
  assert.equal(readFileSync(path.join(wa, "a.txt"), "utf8"), "alpha\n");
  bUntouched(r, b);
  // A dangling link at the leaf is replaced too.
  rmSync(path.join(wa, "a.txt"));
  symlinkSync(path.join(r.tmp, "nowhere"), path.join(wa, "a.txt"));
  assert.equal((await restore("a.txt")).ok, true);
  assert.equal(readFileSync(path.join(wa, "a.txt"), "utf8"), "alpha\n");
  // A leaf that is a link to a DIRECTORY is refused.
  rmSync(path.join(wa, "a.txt"));
  symlinkSync(dirOf(r, b), path.join(wa, "a.txt"));
  assert.equal((await restore("a.txt")).error?.code, "E_INVALID_ARGUMENT");
  assert.equal(readlinkSync(path.join(wa, "a.txt")), dirOf(r, b));
  bUntouched(r, b);
});

test("hooks: only the user's own connection sees a workspace; the re-check under the lock keeps an approval unspent", { skip }, async (t) => {
  const r = await worktreesRig();
  t.after(() => r.cleanup());
  const user = await r.connect();
  const { id } = await createWs(user);
  assert.equal((await user.call(WT, "finalise", { id, outcome: "archived" }, newKey())).ok, true);
  const agentCtx = { identity: { connectionId: "c", windowId: "w", actorId: "a", actor: "agent:x", trusted: true, clientKind: "desktop" }, requestId: "q", correlationId: "c", signal: live };
  const hook = r.binding.content.remove as unknown as (c: unknown, p: unknown) => unknown;
  assert.throws(() => hook(agentCtx, { id }), (e: unknown) => e instanceof DaemonError && e.code === "E_NOT_FOUND" && e.message === "The workspace or item was not found.");
  assert.throws(() => hook(agentCtx, { id: "ws-unknown" }), (e: unknown) => e instanceof DaemonError && e.code === "E_NOT_FOUND");
  // Issue and approve a remove, then the workspace is flagged before the retry: the hook refuses BEFORE the spend ...
  const first = await user.call(WT, "remove", { id }, newKey());
  const c = challengeOf(first);
  await waitFor(() => r.nativeConfirms().length > 0);
  const sent = r.nativeConfirms().at(-1) as Record<string, unknown>;
  await approve4(r as never, user, { challenge: c, proof: String(sent["proof"]), key: "k", sent, first } as never);
  r.db.exec(`UPDATE agent_workspaces SET base_sha = '${"1".repeat(40)}' WHERE id = '${id}'`);
  await r.binding.service.reconcile(live);
  const key = newKey();
  assert.equal((await user.call(WT, "remove", { id, approval: { challengeId: c.challengeId } }, key)).ok, false);
  assert.equal(existsSync(dirOf(r, id)), true);
  // ... so once the flag clears, the same approval still works.
  r.db.exec(`UPDATE agent_workspaces SET base_sha = '${r.journal.getWorkspace(id)?.baseSha === "1".repeat(40) ? r.git(r.repo, "rev-parse", "main").trim() : "x"}' WHERE id = '${id}'`);
  await r.binding.service.reconcile(live);
  const ok = await user.call(WT, "remove", { id, approval: { challengeId: c.challengeId } }, newKey());
  assert.equal(ok.ok, true, JSON.stringify(ok.error));
});

test("hook re-check under the lock: a workspace flagged while the call waits for the project mutex is refused BEFORE the approval is spent", { skip }, async (t) => {
  const r = await worktreesRig();
  t.after(() => r.cleanup());
  const user = await r.connect();
  const { id } = await createWs(user);
  assert.equal((await user.call(WT, "finalise", { id, outcome: "archived" }, newKey())).ok, true);
  const first = await user.call(WT, "remove", { id }, newKey());
  const c = challengeOf(first);
  await waitFor(() => r.nativeConfirms().length > 0);
  const sent = r.nativeConfirms().at(-1) as Record<string, unknown>;
  await approve4(r as never, user, { challenge: c, proof: String(sent["proof"]), key: "k", sent, first } as never);
  const good = String(r.journal.getWorkspace(id)?.baseSha);
  const projectId = String(r.journal.getWorkspace(id)?.projectId);
  let pending: Promise<unknown> = Promise.resolve();
  // Hold the project mutex; the retry passes the hook's first check, then waits; the flag appears while it waits.
  await r.binding.mutex.run(projectId, async () => {
    pending = user.call(WT, "remove", { id, approval: { challengeId: c.challengeId } }, newKey());
    await new Promise((res) => setTimeout(res, 300));
    r.db.exec(`UPDATE agent_workspaces SET base_sha = '${"1".repeat(40)}' WHERE id = '${id}'`);
    await r.binding.service.reconcile(live);
  });
  const refused = (await pending) as { ok?: boolean };
  assert.equal(refused.ok, false);
  assert.equal(existsSync(dirOf(r, id)), true);
  r.db.exec(`UPDATE agent_workspaces SET base_sha = '${good}' WHERE id = '${id}'`);
  await r.binding.service.reconcile(live);
  const ok = await user.call(WT, "remove", { id, approval: { challengeId: c.challengeId } }, newKey());
  assert.equal(ok.ok, true, JSON.stringify(ok.error));
});
