// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test, type TestContext } from "node:test";
import { AuditLog, openDatabase } from "@axis/audit";
import { Journal } from "@axis/journal";
import { createPagesContentHooks, createPagesHandlers, createPagesService } from "../src/index.js";
import { challengeOf, newKey, rig, type Client, type Rig } from "./approvals-rig.js";
import { resolve, waitFor } from "./approvals-helpers.js";

// Threat model 2a O-4: marking a page version reviewed (it lowers taint) and deleting a page need main's native dialog,
// which names the page from values the daemon derives. Through the real approvals gate: the renderer's own `resolve`
// never releases them; only the dialog's proof does; a page that changed since the dialog is refused.

const C = "axis.pages";

async function setup(t: TestContext) {
  const notes = new Map<string, string>();
  const r = await rig({ describe: (_i, c) => notes.get(`${c.target}|${c.contentDigest}`) });
  t.after(() => r.cleanup());
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const journal = Journal.open(db, { audit: new AuditLog(db) });
  journal.registerProject({ id: "p", path: "/repo/p", displayName: "Shop", trusted: false, actor: "user" });
  const service = createPagesService({ journal, audit: { append: () => undefined }, random: { bytes: (n) => randomBytes(n) } });
  r.daemon.register(C, 1, createPagesHandlers(service), { content: createPagesContentHooks({ journal, onPreview: (target, digest, text) => void notes.set(`${target}|${digest}`, text) }) });
  const pageId = service.create({ kind: "user" }, { projectId: "p", title: "Plan", body: "x" }).version.meta.pageId;
  service.update({ kind: "agent", agentId: "w1", projectId: "p", runId: "r", receivedHop: 1 }, { pageId, baseSeq: 1, title: "SAFE TO CONFIRM", body: "worker!" });
  return { r, service, pageId, user: await r.connect() };
}

async function challenge(r: Rig, user: Client, method: string, payload: Record<string, unknown>, key: string) {
  const first = await user.call(C, method, payload, key);
  assert.equal(first.error?.code, "E_APPROVAL_REQUIRED", JSON.stringify(first.error));
  const c = challengeOf(first);
  await waitFor(() => r.nativeConfirms().some((m) => m["challengeId"] === c.challengeId), 60_000, "main was asked for its dialog");
  const sent = r.nativeConfirms().find((m) => m["challengeId"] === c.challengeId) as Record<string, unknown>;
  return { c, proof: String(sent["proof"]), summary: String(sent["summary"]) };
}
async function confirm(r: Rig, user: Client, ch: Awaited<ReturnType<typeof challenge>>): Promise<void> {
  const before = r.approvals.stats().native.confirmed;
  await resolve(user, ch.c);
  r.answer(ch.c.challengeId, ch.proof, true);
  await waitFor(() => r.approvals.stats().native.confirmed === before + 1, 60_000, "the dialog's answer was applied");
}

const CASES = [
  ["markReviewed", (id: string) => ({ pageId: id, seq: 2 }), (id: string) => `axis.pages/1.markReviewed: page ${id} v2/2, 22 bytes by a worker, in Shop`],
  ["delete", (id: string) => ({ pageId: id }), (id: string) => `axis.pages/1.delete: page ${id}, all 2 versions, in Shop`],
] as const;

for (const [method, payload, line] of CASES) {
  test(`${method} needs main's native dialog, which names the page without its text: the renderer's resolve alone never releases it; the dialog's proof does`, async (t) => {
    const { r, service, pageId, user } = await setup(t);
    const key = newKey();
    const one = await challenge(r, user, method, payload(pageId), key);
    assert.deepEqual([one.c.tier, one.c.nativeConfirmationRequired], [4, true]);
    assert.equal(one.summary, line(pageId), "the dialog names the page from daemon-derived values");
    assert.equal(one.summary.includes("SAFE") || one.summary.includes("worker!"), false, "never the page's title or body");
    assert.deepEqual((await resolve(user, one.c)).result, { challengeId: one.c.challengeId, state: "approved", nativeRequired: true });
    const early = await user.call(C, method, { ...payload(pageId), approval: { challengeId: one.c.challengeId } }, key);
    assert.equal(early.ok, false, "a renderer-only resolve released a tier-4 page call");
    assert.equal(service.get({ pageId, seq: 2 }).version.meta.reviewed, false, "not marked");
    const key2 = newKey();
    const two = await challenge(r, user, method, payload(pageId), key2);
    await confirm(r, user, two);
    const done = await user.call(C, method, { ...payload(pageId), approval: { challengeId: two.c.challengeId } }, key2);
    assert.equal(done.ok, true, JSON.stringify(done.error));
    if (method === "markReviewed") assert.equal(service.get({ pageId, seq: 2 }).version.meta.reviewed, true);
    else assert.throws(() => service.get({ pageId }), /not_found/);
  });
}

test("a page that changed after main's dialog is refused: the approval is bound to the page as the dialog named it", async (t) => {
  const { r, service, pageId, user } = await setup(t);
  const key = newKey();
  const ch = await challenge(r, user, "delete", { pageId }, key);
  await confirm(r, user, ch);
  service.update({ kind: "user" }, { pageId, baseSeq: 2, title: "Plan", body: "a third version" });
  const late = await user.call(C, "delete", { pageId, approval: { challengeId: ch.c.challengeId } }, key);
  assert.equal(late.error?.code, "E_CONFLICT", JSON.stringify(late.error));
  assert.equal(service.get({ pageId }).version.meta.seq, 3, "not deleted");
});

test("the host registers the pages hooks: compose-serving passes them, and registerPagesHandlers hands them to the registrar", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../src/compose-serving.js", import.meta.url), "utf8");
  assert.match(src, /registerPagesHandlers\(registrar, built\.pages, createPagesContentHooks\(/, "the composition passes the content hooks");
  const { registerPagesHandlers } = await import("../src/index.js");
  const seen: unknown[] = [];
  const hooks = { markReviewed: (() => undefined) as never, delete: (() => undefined) as never };
  registerPagesHandlers({ register: (_c, _v, _h, o) => void seen.push(o) }, {} as never, hooks);
  assert.deepEqual(seen, [{ content: hooks }]);
});
