// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { challengeOf, newKey, type Msg } from "./approvals-rig.js";
import { approve4, waitFor } from "./approvals-helpers.js";
import { START, runsRig } from "./runs-rig.js";
import { createWs as createWsRaw, gitSkipReason } from "./worktrees-rig.js";

const skip = gitSkipReason();
const create = async (user: Parameters<typeof createWsRaw>[0]): Promise<string> => (await createWsRaw(user, (_m, x) => (assert.equal(x.ok, true, JSON.stringify(x.error)), x))).id;

test("a start that races a finalise never runs in a workspace being changed (project mutex, state re-read)", { skip }, async (t) => {
  const hold: { reached: () => void; gate: Promise<void>; open: () => void } = { reached: () => undefined, gate: Promise.resolve(), open: () => undefined };
  let reached!: Promise<void>;
  const r = await runsRig({
    testSeams: {
      wrapManager: (m) => ({
        ...m,
        finalise: async (a) => {
          hold.reached();
          await hold.gate;
          return m.finalise(a);
        },
      }),
    },
  });
  t.after(() => r.cleanup());
  const user = await r.connect();
  const id = await create(user);
  reached = new Promise<void>((res) => (hold.reached = res));
  hold.gate = new Promise<void>((res) => (hold.open = res));

  const finalise = user.call("axis.worktrees", "finalise", { id, outcome: "archived" }, newKey());
  await reached; // the finalise holds the project mutex and the journal lock record, and has not touched git yet
  const start = user.call("axis.cli-runs", "start", START(id), newKey());
  // The binding is safe on its own too (a caller that is not the handler): its start waits for the project as well.
  const direct = r.runs.service.start({
    workspaceId: id,
    agent: (r.answers.agents as unknown[])[0],
    actor: "user",
    trust: r.handlerDeps.minter.attest({ workspaceId: id, projectId: r.projectId }),
  });
  const directOutcome = direct.then(() => "started", (e: { details?: { reason?: string } }) => e.details?.reason);
  await new Promise((res) => setTimeout(res, 100));
  assert.equal(r.pty.spawns.length, 0, "no process was spawned while the finalise held the project");
  assert.equal(r.asked.some((m) => m["type"] === "trust.check"), false, "main is not asked until the start holds the project");

  hold.open();
  const f = await finalise;
  assert.equal(f.ok, true, JSON.stringify(f.error));
  const s = await start;
  assert.equal(s.ok, false);
  assert.equal(s.error?.code, "E_CONFLICT");
  assert.equal(s.error?.details?.["reason"], "not_ready");
  assert.equal(await directOutcome, "not_ready");
  assert.equal(r.pty.spawns.length, 0, "the start never reached a spawn");
});

test("a start that races a remove never starts in a directory being deleted", { skip }, async (t) => {
  const hold: { reached: () => void; gate: Promise<void>; open: () => void } = { reached: () => undefined, gate: Promise.resolve(), open: () => undefined };
  const r = await runsRig({
    testSeams: {
      wrapManager: (m) => ({
        ...m,
        remove: async (a) => {
          hold.reached();
          await hold.gate;
          return m.remove(a);
        },
      }),
    },
  });
  t.after(() => r.cleanup());
  const user = await r.connect();
  const id = await create(user);
  const fin = await user.call("axis.worktrees", "finalise", { id, outcome: "archived" }, newKey());
  assert.equal(fin.ok, true, JSON.stringify(fin.error));
  const reached = new Promise<void>((res) => (hold.reached = res));
  hold.gate = new Promise<void>((res) => (hold.open = res));
  const dir = String(r.journal.getWorkspace(id)?.worktreePath);

  // The remove is tier 4: issue the challenge, approve it through the native confirmation, then hold the retry inside the manager.
  const key = newKey();
  const first = await user.call("axis.worktrees", "remove", { id }, key);
  assert.equal(first.error?.code, "E_APPROVAL_REQUIRED", JSON.stringify(first.error));
  const c = challengeOf(first);
  await waitFor(() => r.nativeConfirms().length > 0);
  const sent = r.nativeConfirms().at(-1) as Record<string, unknown>;
  await approve4(r as never, user, { challenge: c, proof: String(sent["proof"]), key, sent, first: {} as Msg });
  const removing = user.call("axis.worktrees", "remove", { id, approval: { challengeId: c.challengeId } }, key);
  await reached;
  const start = user.call("axis.cli-runs", "start", START(id), newKey());
  await new Promise((res) => setTimeout(res, 100));
  assert.equal(r.pty.spawns.length, 0, "nothing was spawned into the directory while it is being removed");
  hold.open();
  assert.equal((await removing).ok, true);
  const s = await start;
  assert.equal(s.ok, false);
  assert.ok(s.error?.code === "E_NOT_FOUND" || s.error?.code === "E_CONFLICT", String(s.error?.code));
  assert.equal(r.pty.spawns.length, 0);
  assert.equal(r.journal.getWorkspace(id)?.state, "REMOVED");
  assert.ok(dir.length > 0);
});

test("a start refuses while the workspace's journal lock is held, and spawns nothing", { skip }, async (t) => {
  const r = await runsRig();
  t.after(() => r.cleanup());
  const user = await r.connect();
  const id = await create(user);
  r.journal.lockWorkspace(id, "user");
  const s = await user.call("axis.cli-runs", "start", START(id), newKey());
  assert.equal(s.error?.code, "E_CONFLICT");
  assert.equal(s.error?.details?.["reason"], "busy");
  assert.equal(r.pty.spawns.length, 0);
  r.journal.unlockWorkspace(id, "user");
  const ok = await user.call("axis.cli-runs", "start", START(id), newKey());
  assert.equal(ok.ok, true, JSON.stringify(ok.error));
  assert.equal(r.pty.spawns.length, 1);
});
