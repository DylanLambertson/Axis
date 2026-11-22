// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { AuditLog, openDatabase } from "@axis/audit";
import { DaemonError, type HandlerContext } from "@axis/daemon";
import { Journal } from "@axis/journal";
import { TASKS_REFUSAL_MESSAGE } from "@axis/protocol";
import { TASKS_PAYLOAD_ALLOWLIST, createTasksHandlers, createTasksService } from "../src/index.js";

// PV-T1 slice 2a: axis.tasks/1 over the bridge. The user's own desktop connection only; closed refusals; audit without text.

const SHA = "b".repeat(40);
function setup() {
  const db = openDatabase(":memory:");
  const audit = new AuditLog(db, { payloadAllowlist: { ...TASKS_PAYLOAD_ALLOWLIST } });
  const journal = Journal.open(db, { audit });
  journal.registerProject({ id: "p", path: "/repo/p", displayName: "p", trusted: false, actor: "user" });
  const service = createTasksService({ journal, audit, random: { bytes: (n) => randomBytes(n) } });
  return { db, audit, journal, service, h: createTasksHandlers(service) };
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
type H = ReturnType<typeof setup>["h"];
const call = (h: H, m: keyof H, payload: unknown, c = ctx()) => h[m](c, payload as never);
const created = async (h: H, title = "Fix it", body = "one") => ((await call(h, "create", { projectId: "p", title, body })) as { task: { taskId: string } }).task.taskId;
const W = { kind: "agent" as const, agentId: "w1", projectId: "p", runId: "r1", receivedHop: 2 };

test("only the user's own desktop connection: a worker, a plugin and a web client get not_found; an aborted call is cancelled", async () => {
  const { h } = setup();
  for (const identity of [{ actor: "agent:w1", clientKind: "desktop" }, { actor: "plugin:acme", clientKind: "plugin" }, { actor: "user", clientKind: "web" }]) {
    assert.deepEqual(await refusal(call(h, "list", { projectId: "p" }, ctx(identity))), ["E_NOT_FOUND", "not_found", TASKS_REFUSAL_MESSAGE], JSON.stringify(identity));
  }
  assert.equal((await refusal(call(h, "list", { projectId: "p" }, ctx(undefined, true))))[0], "E_CANCELLED");
});

test("every method as the user; each answer passes the response schema; a worker's revision makes the task untrusted at its hop", async () => {
  const { h, service, journal } = setup();
  const w = journal.createWorkspace({ projectId: "p", branch: "axis/a", baseRef: "main", baseSha: SHA, createdBy: "user" }).value;
  const taskId = await created(h);
  service.update(W, { taskId, baseSeq: 1, title: "Fix it", body: "worker" });
  const got = (await call(h, "get", { taskId })) as { task: { untrusted: boolean; hop: number; source: string }; revision: { meta: { author: unknown } } };
  assert.deepEqual([got.task.source, got.task.untrusted, got.task.hop, got.revision.meta.author], ["user", true, 2, { kind: "agent", agentId: "w1" }]);
  assert.equal(((await call(h, "update", { taskId, baseSeq: 2, title: "Fix it", body: "mine" })) as { task: { lastSeq: number; untrusted: boolean } }).task.untrusted, true, "sticky");
  assert.equal(((await call(h, "setStatus", { taskId, status: "done" })) as { task: { status: string } }).task.status, "done");
  assert.deepEqual(((await call(h, "link", { taskId, link: { kind: "workspace", target: w.id } })) as { changed: boolean }).changed, true);
  assert.deepEqual(((await call(h, "unlink", { taskId, link: { kind: "workspace", target: w.id } })) as { changed: boolean }).changed, true);
  assert.equal(((await call(h, "revisions", { taskId })) as { revisions: unknown[] }).revisions.length, 3);
  assert.equal(((await call(h, "list", { projectId: "p" })) as { tasks: unknown[]; more: boolean }).tasks.length, 1);
  assert.deepEqual(await call(h, "delete", { taskId }), { deleted: true });
  assert.deepEqual(await refusal(call(h, "get", { taskId })), ["E_NOT_FOUND", "not_found", TASKS_REFUSAL_MESSAGE]);
});

test("refusals are closed: stale_version, not_found, assignee_refused and too_large keep their reason; anything else is E_INTERNAL with no text", async () => {
  const { h, journal } = setup();
  const taskId = await created(h);
  assert.deepEqual(await refusal(call(h, "update", { taskId, baseSeq: 9, title: "Fix it", body: "two" })), ["E_CONFLICT", "stale_version", TASKS_REFUSAL_MESSAGE]);
  assert.deepEqual(await refusal(call(h, "create", { projectId: "nope", title: "T", body: "x" })), ["E_NOT_FOUND", "not_found", TASKS_REFUSAL_MESSAGE]);
  assert.deepEqual(await refusal(call(h, "assign", { taskId, assignee: { kind: "agent", id: "ghost" } })), ["E_CONFLICT", "assignee_refused", TASKS_REFUSAL_MESSAGE]);
  assert.deepEqual(await refusal(call(h, "create", { projectId: "p", title: "Big", body: "x".repeat(16_385) })), ["E_INVALID_ARGUMENT", "too_large", TASKS_REFUSAL_MESSAGE]);
  // A title the table refuses (a bad request the pipeline's schema would stop): a database error, never echoed.
  assert.deepEqual(await refusal(call(h, "create", { projectId: "p", title: " secret title", body: "x" })), ["E_INTERNAL", undefined, "Request failed"]);
  assert.equal(journal.tasks.list("p").length, 1, "nothing else written");
});

test("audit rows hold ids, kinds, a sequence number and a byte length, written with the change: never a title or a body", async () => {
  const { h, audit, service } = setup();
  const taskId = await created(h, "TITLE-CANARY", "BODY-CANARY");
  service.update(W, { taskId, baseSeq: 1, title: "TITLE-CANARY", body: "BODY-CANARY two" });
  await call(h, "setStatus", { taskId, status: "blocked" });
  await call(h, "assign", { taskId, assignee: null });
  await call(h, "delete", { taskId });
  const rows = audit.list({ limit: 100 }).filter((e) => e.action.startsWith("task."));
  assert.deepEqual(rows.map((e) => [e.action, e.actor]), [["task.create", "user"], ["task.update", "agent:w1"], ["task.status", "user"], ["task.assign", "user"], ["task.delete", "user"]]);
  assert.equal(JSON.stringify(rows).includes("CANARY"), false, "no title or body in the audit");
  assert.deepEqual(rows[1]?.payload, { taskId, projectId: "p", seq: 2, callerKind: "agent", bytes: 12 + 15, authorKind: "agent", runId: "r1" });
  assert.deepEqual(rows[3]?.payload, { taskId, projectId: "p", callerKind: "user", assigneeKind: "none" });
});

test("a write whose audit row cannot be written writes nothing (one transaction)", () => {
  const db = openDatabase(":memory:");
  const journal = Journal.open(db, { audit: new AuditLog(db) });
  journal.registerProject({ id: "p", path: "/repo/p", displayName: "p", trusted: false, actor: "user" });
  const service = createTasksService({ journal, audit: { append: () => { throw new Error("audit down"); } }, random: { bytes: (n) => randomBytes(n) } });
  assert.throws(() => service.create({ kind: "user" }, { projectId: "p", title: "T", body: "x" }), /audit down/);
  assert.deepEqual(journal.tasks.list("p"), []);
});

test("a run's worker sees only its own project's tasks; the allow-list is exactly these keys", () => {
  const { service, journal } = setup();
  journal.registerProject({ id: "q", path: "/repo/q", displayName: "q", trusted: false, actor: "user" });
  const other = service.create({ kind: "user" }, { projectId: "q", title: "Q", body: "x" }).task.taskId;
  assert.throws(() => service.readForRun(W, other), /not_found/);
  assert.throws(() => service.update(W, { taskId: other, baseSeq: 1, title: "Q", body: "y" }), /not_found/);
  assert.throws(() => service.create(W, { projectId: "q", title: "Q", body: "y" }), /not_found/);
  assert.deepEqual(service.listForRun(W), []);
  const keys = ["taskId", "projectId", "seq", "bytes", "authorKind", "callerKind", "runId", "status", "assigneeKind", "linkKind", "changed"];
  assert.deepEqual(Object.keys(TASKS_PAYLOAD_ALLOWLIST).sort(), ["task.assign", "task.create", "task.delete", "task.link", "task.status", "task.unlink", "task.update"]);
  for (const v of Object.values(TASKS_PAYLOAD_ALLOWLIST)) assert.deepEqual([...v], keys);
});
