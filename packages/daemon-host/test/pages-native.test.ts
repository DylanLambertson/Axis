// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test, type TestContext } from "node:test";
import { AuditLog, openDatabase } from "@axis/audit";
import { Journal } from "@axis/journal";
import { createPagesHandlers, createPagesService } from "../src/index.js";
import { challengeOf, newKey, rig, type Client, type Rig } from "./approvals-rig.js";
import { resolve, waitFor } from "./approvals-helpers.js";

// Threat model 2a O-4: marking a page version reviewed (it lowers taint) and deleting a page need main's native dialog.
// Through the real approvals gate: the renderer's own `resolve` never releases them; only the dialog's proof does.

const C = "axis.pages";

async function setup(t: TestContext) {
  const r = await rig();
  t.after(() => r.cleanup());
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const journal = Journal.open(db, { audit: new AuditLog(db) });
  journal.registerProject({ id: "p", path: "/repo/p", displayName: "p", trusted: false, actor: "user" });
  const service = createPagesService({ journal, audit: { append: () => undefined }, random: { bytes: (n) => randomBytes(n) } });
  r.daemon.register(C, 1, createPagesHandlers(service));
  const pageId = service.create({ kind: "user" }, { projectId: "p", title: "Plan", body: "x" }).version.meta.pageId;
  service.update({ kind: "agent", agentId: "w1", projectId: "p", runId: "r", receivedHop: 1 }, { pageId, baseSeq: 1, title: "Plan", body: "worker" });
  return { r, service, pageId, user: await r.connect() };
}

async function challenge(r: Rig, user: Client, method: string, payload: Record<string, unknown>, key: string) {
  const first = await user.call(C, method, payload, key);
  assert.equal(first.error?.code, "E_APPROVAL_REQUIRED", JSON.stringify(first.error));
  const c = challengeOf(first);
  await waitFor(() => r.nativeConfirms().some((m) => m["challengeId"] === c.challengeId), 60_000, "main was asked for its dialog");
  const sent = r.nativeConfirms().find((m) => m["challengeId"] === c.challengeId) as Record<string, unknown>;
  return { c, proof: String(sent["proof"]) };
}

for (const [method, payload] of [["markReviewed", (id: string) => ({ pageId: id, seq: 2 })], ["delete", (id: string) => ({ pageId: id })]] as const) {
  test(`${method} needs main's native dialog: the renderer's resolve alone never releases it; the dialog's proof does`, async (t) => {
    const { r, service, pageId, user } = await setup(t);
    const key = newKey();
    const { c } = await challenge(r, user, method, payload(pageId), key);
    assert.equal(c.nativeConfirmationRequired, true, "issued with a native step");
    assert.equal(c.tier, 4);
    assert.deepEqual((await resolve(user, c)).result, { challengeId: c.challengeId, state: "approved", nativeRequired: true });
    // Resolved by the renderer only: the retry is refused and nothing changed.
    const early = await user.call(C, method, { ...payload(pageId), approval: { challengeId: c.challengeId } }, key);
    assert.equal(early.ok, false, "a renderer-only resolve released a tier-4 page call");
    const unchanged = service.get({ pageId, seq: 2 }).version.meta;
    assert.equal(unchanged.reviewed, false, "not marked");
    // Main's dialog answers with the proof: a fresh challenge then runs once.
    const key2 = newKey();
    const second = await challenge(r, user, method, payload(pageId), key2);
    await resolve(user, second.c);
    r.answer(second.c.challengeId, second.proof, true);
    await waitFor(() => r.approvals.stats().native.entries === 0, 60_000, "the dialog's answer was applied");
    const done = await user.call(C, method, { ...payload(pageId), approval: { challengeId: second.c.challengeId } }, key2);
    assert.equal(done.ok, true, JSON.stringify(done.error));
    if (method === "markReviewed") assert.equal(service.get({ pageId, seq: 2 }).version.meta.reviewed, true);
    else assert.throws(() => service.get({ pageId }), /not_found/);
  });
}
