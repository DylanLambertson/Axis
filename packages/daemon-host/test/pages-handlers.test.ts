// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { AuditLog, openDatabase } from "@axis/audit";
import { DaemonError, type HandlerContext } from "@axis/daemon";
import { Journal } from "@axis/journal";
import { PAGES_REFUSAL_MESSAGE } from "@axis/protocol";
import { PAGES_PAYLOAD_ALLOWLIST, createPagesHandlers, createPagesService, type PageCaller } from "../src/index.js";

// PV-Q1 slice 2: axis.pages/1 over the bridge. The user's own desktop connection only; closed refusals; audit without text.

function setup() {
  const db = openDatabase(":memory:");
  const audit = new AuditLog(db, { payloadAllowlist: { ...PAGES_PAYLOAD_ALLOWLIST } });
  const journal = Journal.open(db, { audit });
  journal.registerProject({ id: "p", path: "/repo/p", displayName: "p", trusted: false, actor: "user" });
  const service = createPagesService({ journal, audit, random: { bytes: (n) => randomBytes(n) } });
  return { db, audit, journal, service, h: createPagesHandlers(service) };
}
const ctx = (identity: Record<string, unknown> = { actor: "user", clientKind: "desktop" }, aborted = false): HandlerContext =>
  ({ identity, signal: { aborted } as AbortSignal }) as unknown as HandlerContext;
async function refusal(p: unknown): Promise<[string, string | undefined, string]> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof DaemonError);
    return [e.code, (e.details as { reason?: string } | undefined)?.reason, e.message];
  }
  assert.fail("not refused");
}
const call = (h: ReturnType<typeof setup>["h"], m: keyof ReturnType<typeof setup>["h"], payload: unknown, c = ctx()) => h[m](c, payload as never);

test("only the user's own desktop connection: an agent, a plugin and a web client get not_found", async () => {
  const { h } = setup();
  for (const identity of [{ actor: "agent:w1", clientKind: "desktop" }, { actor: "plugin:acme", clientKind: "plugin" }, { actor: "user", clientKind: "web" }]) {
    assert.deepEqual(await refusal(call(h, "list", { projectId: "p" }, ctx(identity))), ["E_NOT_FOUND", "not_found", PAGES_REFUSAL_MESSAGE], JSON.stringify(identity));
  }
  assert.deepEqual((await refusal(call(h, "list", { projectId: "p" }, ctx(undefined, true))))[0], "E_CANCELLED");
});

test("create, update, restore, review and delete as the user; each answer passes the response schema", async () => {
  const { h, service } = setup();
  const created = (await call(h, "create", { projectId: "p", title: "Plan", body: "one" })) as { version: { meta: { pageId: string; author: unknown } } };
  const pageId = created.version.meta.pageId;
  assert.deepEqual(created.version.meta.author, { kind: "user" });
  service.update({ kind: "agent", agentId: "w1", projectId: "p", runId: "r1", receivedHop: 2 }, { pageId, baseSeq: 1, title: "Plan", body: "agent" });
  const restored = (await call(h, "restore", { pageId, seq: 2, baseSeq: 2 })) as { version: { meta: { author: unknown; untrusted: boolean; hop: number } } };
  assert.deepEqual([restored.version.meta.author, restored.version.meta.untrusted, restored.version.meta.hop], [{ kind: "agent", agentId: "w1" }, true, 2], "a restore keeps the author");
  const reviewed = (await call(h, "markReviewed", { pageId, seq: 3 })) as { changed: boolean; version: { reviewed: boolean } };
  assert.deepEqual([reviewed.changed, reviewed.version.reviewed], [true, true]);
  const list = (await call(h, "list", { projectId: "p" })) as { pages: { current: { seq: number } }[] };
  assert.deepEqual(list.pages.map((x) => x.current.seq), [3]);
  assert.equal(((await call(h, "versions", { pageId })) as { versions: unknown[] }).versions.length, 3);
  assert.deepEqual(await call(h, "delete", { pageId }), { deleted: true });
  assert.deepEqual(await refusal(call(h, "get", { pageId })), ["E_NOT_FOUND", "not_found", PAGES_REFUSAL_MESSAGE]);
});

test("refusals are closed: stale_version and not_found keep their reason; anything else is E_INTERNAL with no text", async () => {
  const { h } = setup();
  const pageId = ((await call(h, "create", { projectId: "p", title: "Plan", body: "one" })) as { version: { meta: { pageId: string } } }).version.meta.pageId;
  assert.deepEqual(await refusal(call(h, "update", { pageId, baseSeq: 9, title: "Plan", body: "two" })), ["E_CONFLICT", "stale_version", PAGES_REFUSAL_MESSAGE]);
  assert.deepEqual(await refusal(call(h, "create", { projectId: "nope", title: "Plan", body: "x" })), ["E_NOT_FOUND", "not_found", PAGES_REFUSAL_MESSAGE]);
  assert.deepEqual(await refusal(call(h, "restore", { pageId, seq: 5, baseSeq: 1 })), ["E_NOT_FOUND", "not_found", PAGES_REFUSAL_MESSAGE]);
  // A title the table refuses (a bad request the pipeline's schema would stop): a database error, never echoed.
  assert.deepEqual(await refusal(call(h, "create", { projectId: "p", title: " secret title", body: "x" })), ["E_INTERNAL", undefined, "Request failed"]);
});

test("audit rows hold ids, kinds, a sequence number and a byte length: never a title or a body", async () => {
  const { h, audit, service } = setup();
  const pageId = ((await call(h, "create", { projectId: "p", title: "TITLE-CANARY", body: "BODY-CANARY" })) as { version: { meta: { pageId: string } } }).version.meta.pageId;
  service.update({ kind: "agent", agentId: "w1", projectId: "p", runId: "r1", receivedHop: 0 } as PageCaller, { pageId, baseSeq: 1, title: "TITLE-CANARY", body: "BODY-CANARY two" });
  await call(h, "markReviewed", { pageId, seq: 2 });
  await call(h, "delete", { pageId });
  const rows = audit.list({ limit: 100 }).filter((e) => e.action.startsWith("page."));
  assert.deepEqual(rows.map((e) => [e.action, e.actor]), [["page.create", "user"], ["page.update", "agent:w1"], ["page.review", "user"], ["page.delete", "user"]]);
  const text = JSON.stringify(rows);
  assert.equal(text.includes("CANARY"), false, "no title or body in the audit");
  assert.deepEqual(rows[1]?.payload, { pageId, projectId: "p", seq: 2, callerKind: "agent", bytes: 12 + 15, authorKind: "agent", runId: "r1" });
});

test("a run's worker sees only its own project's pages", () => {
  const { service, journal } = setup();
  journal.registerProject({ id: "q", path: "/repo/q", displayName: "q", trusted: false, actor: "user" });
  const other = service.create({ kind: "user" }, { projectId: "q", title: "Q", body: "x" }).version.meta.pageId;
  const w = { kind: "agent" as const, agentId: "w1", projectId: "p", runId: "r1", receivedHop: 0 };
  assert.throws(() => service.readForRun(w, other), /not_found/);
  assert.throws(() => service.update(w, { pageId: other, baseSeq: 1, title: "Q", body: "y" }), /not_found/);
  assert.throws(() => service.create(w, { projectId: "q", title: "Q", body: "y" }), /not_found/);
});

test("the audit allow-list is exactly these keys for every page row", () => {
  const keys = ["pageId", "projectId", "seq", "bytes", "authorKind", "callerKind", "runId", "changed"];
  assert.deepEqual(Object.keys(PAGES_PAYLOAD_ALLOWLIST).sort(), ["page.create", "page.delete", "page.restore", "page.review", "page.update"]);
  for (const v of Object.values(PAGES_PAYLOAD_ALLOWLIST)) assert.deepEqual([...v], keys);
});

test("a body over 256 KiB through the service is the closed too_large, nothing written", async () => {
  const { h, journal } = setup();
  assert.deepEqual(await refusal(call(h, "create", { projectId: "p", title: "Big", body: "é".repeat(131_073) })), ["E_INVALID_ARGUMENT", "too_large", PAGES_REFUSAL_MESSAGE]);
  assert.deepEqual(journal.pages.list("p"), []);
});
