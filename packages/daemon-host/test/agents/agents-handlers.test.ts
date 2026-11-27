// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AuditLog, AxisError, openDatabase } from "@axis/audit";
import { DaemonError, type Handler, type HandlerContext, type Identity } from "@axis/daemon";
import { AGENT_RECORD_ACTION, Journal } from "@axis/journal";
import { AGENTS_REFUSAL_MESSAGE } from "@axis/protocol";
import { createAgentsService, type AgentsService } from "../../src/agents/service.js";
import { createAgentsHandlers, newAgentId } from "../../src/handlers/agents.js";
import { InMemoryTrustRegistry } from "../../src/policy/trust-registry.js";
import { ProjectMutex } from "../../src/worktrees/project-mutex.js";

// axis.agents/1 and axis.agent-groups/1 served (PV-G3): only the user's desktop connection, trust checked by the create
// handler itself when it makes a worktree (agents-contract.md 4.4), refusals closed, every answer schema-checked.

const CLI = { kind: "cli", entryId: "my-cli" } as const;
const COMPOSER = { kind: "composer", connection: "conn", modelId: "model-1", mode: "agent" } as const;
const WINDOW = "win-1";

function setup(options: { failCreate?: Error } = {}) {
  const db = openDatabase(":memory:");
  const audit = new AuditLog(db);
  const journal = Journal.open(db, { audit });
  for (const id of ["p1", "p2"]) journal.registerProject({ id, path: `/repo/${id}`, displayName: id, trusted: false, actor: "user" });
  const ready = (projectId: string): string => {
    const id = journal.createWorkspace({ projectId, branch: `axis/${Math.random().toString(36).slice(2, 9)}`, baseRef: "HEAD", baseSha: "c".repeat(40), createdBy: "user" }).value.id;
    journal.transitionWorkspace(id, "READY");
    return id;
  };
  const made: Array<{ projectId: string; name: string; baseRef?: string }> = [];
  const worktrees = {
    create: async (req: { projectId: string; name: string; baseRef?: string }) => {
      made.push({ ...req });
      if (options.failCreate !== undefined) throw options.failCreate;
      return { id: ready(req.projectId) } as never;
    },
  };
  const trust = new InMemoryTrustRegistry();
  let writes = 0;
  let n = 0;
  const service = createAgentsService({ journal, worktrees, mutex: new ProjectMutex(), trust, newId: () => `id${++n}`, noteWrite: () => void writes++ });
  const handlers = createAgentsHandlers(service);
  return { journal, audit, ready, made, trust, handlers, service, writes: () => writes };
}

function identity(over: Partial<Identity> = {}): Identity {
  return { connectionId: "c1", windowId: WINDOW, actorId: "u", actor: "user", trusted: true, clientKind: "desktop", ...over };
}
function call(h: Handler, payload: unknown, over: Partial<Identity> = {}, signal = new AbortController().signal): Promise<unknown> {
  return h({ identity: identity(over), signal, requestId: "r", correlationId: "c" } as unknown as HandlerContext, payload as never) as Promise<unknown>;
}
async function refused(p: Promise<unknown>, code: string, reason?: string): Promise<void> {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof DaemonError);
    assert.equal(e.code, code);
    assert.deepEqual(e.details, reason === undefined ? undefined : { reason });
    if (reason !== undefined) assert.equal(e.message, AGENTS_REFUSAL_MESSAGE);
    return true;
  });
}

test("only the user's own desktop connection: any other actor or a web client is not_found, for reads too", async () => {
  const { handlers } = setup();
  for (const over of [{ actor: "daemon" }, { actor: "agent:x" }, { clientKind: "web" }] as Partial<Identity>[]) {
    await refused(call(handlers.agents.list, { projectId: "p1" }, over), "E_NOT_FOUND", "not_found");
    await refused(call(handlers.groups.create, { projectId: "p1", name: "G" }, over), "E_NOT_FOUND", "not_found");
  }
  const aborted = new AbortController();
  aborted.abort();
  await refused(call(handlers.agents.list, { projectId: "p1" }, {}, aborted.signal), "E_CANCELLED");
});

test("create with an existing home needs no trust; it is audited and the anchor is told", async () => {
  const { handlers, ready, made, audit, writes } = setup();
  const home = ready("p1");
  const out = (await call(handlers.agents.create, { projectId: "p1", name: "Helper", launch: CLI, home: { existing: home } }, { trusted: false })) as { agent: { id: string; homeWorkspaceId: string } };
  assert.equal(out.agent.homeWorkspaceId, home);
  assert.deepEqual(made, [], "no worktree was made");
  assert.equal(writes(), 1);
  const ev = audit.list().filter((e) => e.action === AGENT_RECORD_ACTION);
  assert.deepEqual(ev.map((e) => [e.actor, (e.payload as { field: string }).field]), [["user", "create"]]);
  await refused(call(handlers.agents.create, { projectId: "p1", name: "X", launch: CLI, home: { existing: ready("p2") } }), "E_CONFLICT", "cross_project");
  await refused(call(handlers.agents.create, { projectId: "p1", name: "X", launch: CLI, home: { existing: "nope" } }), "E_NOT_FOUND", "not_found");
  await refused(call(handlers.agents.create, { projectId: "px", name: "X", launch: CLI, home: { existing: home } }), "E_NOT_FOUND", "not_found");
});

test("create with a new home checks trust itself: the attested flag AND the live registry, and a revoke refuses the next", async () => {
  const { handlers, made, trust } = setup();
  const req = { projectId: "p1", name: "Planner", launch: COMPOSER, home: { new: { name: "planner", baseRef: "main" } } };
  await refused(call(handlers.agents.create, req, { trusted: false }), "E_CONFLICT", "untrusted_project");
  await refused(call(handlers.agents.create, req), "E_CONFLICT", "untrusted_project"); // flag set, registry silent
  trust.set({ windowId: WINDOW }, true);
  await refused(call(handlers.agents.create, req, { trusted: false }), "E_CONFLICT", "untrusted_project"); // registry grants, flag false
  assert.deepEqual(made, [], "no worktree for any refused create");
  const out = (await call(handlers.agents.create, req)) as { agent: { name: string; launch: unknown } };
  assert.deepEqual([out.agent.name, out.agent.launch], ["Planner", COMPOSER]);
  assert.deepEqual(made, [{ projectId: "p1", name: "planner", baseRef: "main" }]);
  trust.set({ windowId: WINDOW, workspaceId: "ws-x" }, false);
  await refused(call(handlers.agents.create, { ...req, name: "Two" }, { workspaceId: "ws-x" }), "E_CONFLICT", "untrusted_project");
  trust.set({ windowId: WINDOW }, false);
  await refused(call(handlers.agents.create, { ...req, name: "Two" }), "E_CONFLICT", "untrusted_project");
  assert.equal(made.length, 1);
});

test("create with a new home refuses before making a worktree when the record would refuse", async () => {
  const { handlers, made, trust, ready, service } = setup();
  trust.set({ windowId: WINDOW }, true);
  const user = { ctx: { caller: { actor: "user", connectionId: "c", windowId: WINDOW }, signal: new AbortController().signal }, trusted: true, windowId: WINDOW };
  await service.groups.create(user, { projectId: "p2", name: "Other" });
  await call(handlers.agents.create, { projectId: "p1", name: "Taken", launch: CLI, home: { existing: ready("p1") } });
  const fresh = { projectId: "p1", launch: CLI, home: { new: { name: "w" } } };
  await refused(call(handlers.agents.create, { ...fresh, name: "TAKEN" }), "E_CONFLICT", "name_taken");
  await refused(call(handlers.agents.create, { ...fresh, name: "N", groupId: "id1" }), "E_CONFLICT", "cross_project");
  await refused(call(handlers.agents.create, { ...fresh, name: "N", groupId: "nope" }), "E_NOT_FOUND", "not_found");
  assert.deepEqual(made, []);
});

test("a worktree that cannot be made is home_unavailable; a cancelled one stays cancelled", async () => {
  const req = { projectId: "p1", name: "N", launch: CLI, home: { new: { name: "w" } } };
  const failing = setup({ failCreate: new DaemonError("E_NOT_FOUND", "x", { reason: "base_ref" }) });
  failing.trust.set({ windowId: WINDOW }, true);
  await refused(call(failing.handlers.agents.create, req), "E_CONFLICT", "home_unavailable");
  const cancelled = setup({ failCreate: new DaemonError("E_CANCELLED", "The request was cancelled.") });
  cancelled.trust.set({ windowId: WINDOW }, true);
  await refused(call(cancelled.handlers.agents.create, req), "E_CANCELLED");
});

test("update is one transaction: a launch of the other kind refuses and the rename with it is not kept", async () => {
  const { handlers, ready, journal } = setup();
  const created = (await call(handlers.agents.create, { projectId: "p1", name: "A", launch: CLI, home: { existing: ready("p1") } })) as { agent: { id: string } };
  const id = created.agent.id;
  await refused(call(handlers.agents.update, { agentId: id, name: "B", launch: COMPOSER }), "E_CONFLICT", "kind_changed");
  assert.equal(journal.agents.get(id)?.name, "A");
  const ok = (await call(handlers.agents.update, { agentId: id, name: "B", launch: { kind: "cli", entryId: "other" } })) as { agent: { name: string }; changed: boolean };
  assert.deepEqual([ok.agent.name, ok.changed], ["B", true]);
  assert.equal(((await call(handlers.agents.update, { agentId: id, name: "B" })) as { changed: boolean }).changed, false);
  await refused(call(handlers.agents.update, { agentId: "nope", name: "B" }), "E_NOT_FOUND", "not_found");
  assert.equal(((await call(handlers.agents.archive, { agentId: id })) as { agent: { archived: boolean } }).agent.archived, true);
  await refused(call(handlers.agents.update, { agentId: id, name: "C" }), "E_CONFLICT", "archived");
  assert.equal(((await call(handlers.agents.restore, { agentId: id })) as { changed: boolean }).changed, true);
  assert.deepEqual(((await call(handlers.agents.list, { projectId: "p1" })) as { agents: unknown[] }).agents.length, 1);
  assert.deepEqual(((await call(handlers.agents.get, { agentId: id })) as { agent: { id: string } }).agent.id, id);
});

test("groups through the handlers: create in order, rename, reorder, assign within the project, delete ungroups", async () => {
  const { handlers, ready } = setup();
  const g1 = ((await call(handlers.groups.create, { projectId: "p1", name: "One" })) as { group: { id: string; order: number } }).group;
  const g2 = ((await call(handlers.groups.create, { projectId: "p1", name: "Two" })) as { group: { id: string; order: number } }).group;
  assert.deepEqual([g1.order, g2.order], [0, 1]);
  const other = ((await call(handlers.groups.create, { projectId: "p2", name: "Else" })) as { group: { id: string } }).group;
  assert.equal(((await call(handlers.groups.rename, { groupId: g1.id, name: "First" })) as { group: { name: string } }).group.name, "First");
  await refused(call(handlers.groups.reorder, { projectId: "p1", order: [g2.id] }), "E_CONFLICT", "order_mismatch");
  assert.deepEqual(((await call(handlers.groups.reorder, { projectId: "p1", order: [g2.id, g1.id] })) as { groups: Array<{ id: string }> }).groups.map((g) => g.id), [g2.id, g1.id]);
  const a = ((await call(handlers.agents.create, { projectId: "p1", name: "A", launch: CLI, home: { existing: ready("p1") } })) as { agent: { id: string } }).agent;
  await refused(call(handlers.groups.assign, { agentId: a.id, groupId: other.id }), "E_CONFLICT", "cross_project");
  assert.equal(((await call(handlers.groups.assign, { agentId: a.id, groupId: g1.id })) as { agent: { groupId: string } }).agent.groupId, g1.id);
  assert.deepEqual(((await call(handlers.groups.delete, { groupId: g1.id })) as { ungrouped: string[] }).ungrouped, [a.id]);
  assert.deepEqual(((await call(handlers.groups.list, { projectId: "p1" })) as { groups: Array<{ id: string }> }).groups.map((g) => g.id), [g2.id]);
  await refused(call(handlers.groups.list, { projectId: "nope" }), "E_NOT_FOUND", "not_found");
});

test("anything outside the closed set is E_INTERNAL with no text of its own, and a bad answer never leaves", async () => {
  const broken = (fn: () => Promise<unknown>): AgentsService => {
    const one = async () => fn();
    return { agents: { list: one, get: one, create: one, update: one, archive: one, restore: one }, groups: { list: one, create: one, rename: one, reorder: one, delete: one, assign: one } } as unknown as AgentsService;
  };
  const leaky = createAgentsHandlers(broken(async () => Promise.reject(new Error("/home/secret/path"))));
  await assert.rejects(call(leaky.agents.list, { projectId: "p1" }), (e: unknown) => e instanceof DaemonError && e.code === "E_INTERNAL" && e.details === undefined && !e.message.includes("secret"));
  const shaped = createAgentsHandlers(broken(async () => ({ agents: [{ id: "x", extra: 1 }] })));
  await assert.rejects(call(shaped.agents.list, { projectId: "p1" }), (e: unknown) => e instanceof DaemonError && e.code === "E_INTERNAL");
  const unknownReason = createAgentsHandlers(broken(async () => Promise.reject(Object.assign(new (await import("../../src/agents/service.js")).AgentRefusal("E_CONFLICT", "made_up")))));
  await assert.rejects(call(unknownReason.agents.list, { projectId: "p1" }), (e: unknown) => e instanceof DaemonError && e.code === "E_INTERNAL");
});

test("a fresh id is a journal id from the CSPRNG", () => {
  const ids = new Set(Array.from({ length: 200 }, () => newAgentId()));
  assert.equal(ids.size, 200);
  for (const id of ids) assert.match(id, /^a[A-Za-z0-9_-]{20}$/);
});

test("the new-home decision is one seam: an injected admission replaces the registry rule and gets the project", async () => {
  const { journal, ready } = setup();
  const asked: string[] = [];
  const made: string[] = [];
  const worktrees = { create: async (req: { projectId: string }) => (made.push(req.projectId), { id: ready(req.projectId) } as never) };
  const service = createAgentsService({ journal, worktrees, mutex: new ProjectMutex(), trust: { isTrusted: () => true }, newId: () => newAgentId(), admitNewHome: (_c, projectId) => (asked.push(projectId), projectId === "p2") });
  const h = createAgentsHandlers(service);
  const req = (projectId: string) => ({ projectId, name: "N", launch: CLI, home: { new: { name: "w" } } });
  await refused(call(h.agents.create, req("p1")), "E_CONFLICT", "untrusted_project");
  await call(h.agents.create, req("p2"), { trusted: false });
  assert.deepEqual([asked, made], [["p1", "p2"], ["p2"]]);
});

test("S1b review 3 N1/N2: the record admits a new home but the project trust gate refuses through the create (e.g. main's Workspace Trust says no): untrusted_project, not home_unavailable", async () => {
  const gateRefusal = new AxisError("E_POLICY_DENIED", "The project is not trusted", { reason: "untrusted" });
  const s = setup({ failCreate: gateRefusal });
  s.trust.set({ windowId: WINDOW }, true); // the early check admits: the refusal comes from the gate at the port
  const req = { projectId: "p1", name: "Worker", launch: CLI, home: { new: { name: "Worker home" } } };
  await refused(call(s.handlers.agents.create, req), "E_CONFLICT", "untrusted_project");
  assert.equal(s.made.length, 1, "the create was reached; the gate refused inside it");
  // Any other failure of the create is still an unavailable home.
  const other = setup({ failCreate: new Error("disk full") });
  other.trust.set({ windowId: WINDOW }, true);
  await refused(call(other.handlers.agents.create, req), "E_CONFLICT", "home_unavailable");
});

test("S2 review N5: a different policy refusal through the create stays home_unavailable (only the trust gate's untrusted maps to untrusted_project)", async () => {
  const s = setup({ failCreate: new AxisError("E_POLICY_DENIED", "Not permitted", { reason: "something_else" }) });
  s.trust.set({ windowId: WINDOW }, true);
  await refused(call(s.handlers.agents.create, { projectId: "p1", name: "Worker", launch: CLI, home: { new: { name: "Worker home" } } }), "E_CONFLICT", "home_unavailable");
});
