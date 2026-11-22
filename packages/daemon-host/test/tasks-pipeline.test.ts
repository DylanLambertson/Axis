// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { AuditLog, openDatabase } from "@axis/audit";
import { Journal } from "@axis/journal";
import { createTasksHandlers, createTasksService } from "../src/index.js";
import { challengeOf, newKey } from "./approvals-rig.js";
import { resolve, setup, waitFor } from "./approvals-helpers.js";

// PV-T1 slice 2a: axis.tasks/1 through the real daemon pipeline, the served rows and the approvals gate. `delete` is
// destructive, tier 4: the renderer's own resolve never releases it; main's native dialog, with its proof, does.

const C = "axis.tasks";

test("delete needs main's native dialog: refused without a challenge, not released by the renderer's resolve alone, run once with the proof", async (t) => {
  const { r, user } = await setup(t);
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const journal = Journal.open(db, { audit: new AuditLog(db) });
  journal.registerProject({ id: "p", path: "/repo/p", displayName: "p", trusted: false, actor: "user" });
  const service = createTasksService({ journal, audit: { append: () => undefined }, random: { bytes: (n) => randomBytes(n) } });
  r.daemon.register(C, 1, createTasksHandlers(service));
  const taskId = service.create({ kind: "user" }, { projectId: "p", title: "Fix it", body: "x" }).task.taskId;
  const issue = async (key: string) => {
    const first = await user.call(C, "delete", { taskId }, key);
    assert.equal(first.error?.code, "E_APPROVAL_REQUIRED");
    const c = challengeOf(first);
    await waitFor(() => r.nativeConfirms().some((m) => m["challengeId"] === c.challengeId), 60_000, "main was asked for its dialog");
    return { c, proof: String(r.nativeConfirms().find((m) => m["challengeId"] === c.challengeId)?.["proof"]) };
  };
  const k1 = newKey();
  const one = await issue(k1);
  assert.deepEqual([one.c.tier, one.c.nativeConfirmationRequired], [4, true]);
  await resolve(user, one.c);
  assert.equal((await user.call(C, "delete", { taskId, approval: { challengeId: one.c.challengeId } }, k1)).ok, false, "renderer-only resolve");
  assert.ok(journal.tasks.get(taskId) !== undefined, "not deleted");
  const k2 = newKey();
  const two = await issue(k2);
  await resolve(user, two.c);
  r.answer(two.c.challengeId, two.proof, true);
  await waitFor(() => r.approvals.stats().native.entries === 0, 60_000, "the dialog's answer was applied");
  assert.deepEqual((await user.call(C, "delete", { taskId, approval: { challengeId: two.c.challengeId } }, k2)).result, { deleted: true });
  assert.equal(journal.tasks.get(taskId), undefined);
  assert.deepEqual((await user.call(C, "list", { projectId: "p" })).result, { tasks: [], more: false });
  const worker = await r.connect("agent:a1#conn-2#win-1");
  assert.equal((await worker.call(C, "list", { projectId: "p" })).error?.code, "E_POLICY_DENIED");
});
