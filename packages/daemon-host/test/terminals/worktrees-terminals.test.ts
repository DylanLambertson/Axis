// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// DC-3a (terminal-trust-revocation.md section 7): finalise and remove close the workspace's plain terminals first (pending opens
// abandoned, live ones closing, revoked, killed), and are refused `active_run`, as for a run, while any of their groups may live.
// With the real worktrees binding over a real repository.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { DaemonError } from "@axis/daemon";
import { TerminalRegistry } from "../../src/terminals/registry.js";
import { createWs as createWsRaw, finaliseApproved, gitSkipReason, worktreesRig } from "../worktrees-rig.js";
import { FakeHandle, FakeTerminalPort } from "./fakes.js";

const skip = gitSkipReason();
const svcCtx = { caller: { actor: "user", connectionId: "c", windowId: "w" }, signal: new AbortController().signal };
const activeRun = (e: unknown): boolean => e instanceof DaemonError && e.details?.["reason"] === "active_run";

async function setup(t: TestContext) {
  const port = new FakeTerminalPort();
  const registry = new TerminalRegistry({ port });
  const r = await worktreesRig({ terminals: registry });
  t.after(() => r.cleanup());
  const user = await r.connect();
  const { id } = await createWsRaw(user, (_m, x) => (assert.equal(x.ok, true, JSON.stringify(x.error)), x));
  const open = (): FakeHandle => {
    const op = registry.reserve(id, String(r.journal.getWorkspace(id)?.projectId));
    assert.ok(op !== undefined);
    const h = new FakeHandle();
    assert.ok(registry.publish(op, h) !== undefined);
    return h;
  };
  return { r, user, id, registry, port, open };
}

test("finalise closes the workspace's terminals; refused active_run while a group survives, then it goes through", { skip }, async (t) => {
  const s = await setup(t);
  const h = s.open();
  h.survives = true;
  const refused = await finaliseApproved(s.r, s.user, s.id, "archived");
  assert.equal(refused.error?.details?.["reason"], "active_run", JSON.stringify(refused.error));
  assert.equal(s.registry.get(h.terminalId)?.state, "closed", "closed first");
  assert.deepEqual(s.port.revokes, [h.terminalId]);
  assert.deepEqual(h.kills, ["SIGKILL"]);
  assert.equal(s.r.journal.getWorkspace(s.id)?.state, "READY", "nothing was finalised");
  h.alive = false;
  const done = await finaliseApproved(s.r, s.user, s.id, "archived");
  assert.equal(done.ok, true, JSON.stringify(done.error));
});

test("remove is refused active_run while a terminal's group lives (closed first), and goes through once it is gone", { skip }, async (t) => {
  const s = await setup(t);
  assert.equal((await finaliseApproved(s.r, s.user, s.id, "archived")).ok, true);
  // A late group recorded for the workspace after finalise (an open that was pending): its slot is still charged.
  const op = s.registry.reserve(s.id, String(s.r.journal.getWorkspace(s.id)?.projectId));
  assert.ok(op !== undefined);
  const late = new FakeHandle();
  late.survives = true;
  s.registry.failed(op, { definitive: false });
  s.registry.late(op, { kind: "spawned", handle: late });
  await assert.rejects(s.r.binding.service.remove({ id: s.id }, svcCtx), activeRun);
  assert.deepEqual(s.r.journal.transitions("workspace", s.id).map((x) => x.to), ["CREATING", "READY", "FINALISED"], "no REMOVING write was made");
  late.alive = false;
  assert.equal((await s.r.binding.service.remove({ id: s.id }, svcCtx)).state, "CLEANED");
});

test("a terminals view that throws counts as busy (fail closed)", { skip }, async (t) => {
  const r = await worktreesRig({ terminals: { closeWorkspace: () => { throw new Error("x"); } } });
  t.after(() => r.cleanup());
  const user = await r.connect();
  const { id } = await createWsRaw(user, (_m, x) => (assert.equal(x.ok, true, JSON.stringify(x.error)), x));
  assert.equal((await finaliseApproved(r, user, id, "archived")).error?.details?.["reason"], "active_run");
});
