// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test, type TestContext } from "node:test";
import { AuditLog, openDatabase } from "@axis/audit";
import { Daemon, MemoryIdempotencyStore, memoryPair, protocolRegistry, type Identity, type IdentityVerifier } from "@axis/daemon";
import { Journal } from "@axis/journal";
import { InMemoryTrustRegistry, RuleTablePolicy, createPagesHandlers, createPagesService } from "../src/index.js";
import { journalWorkerOf } from "../src/agents/directory.js";
import { Client } from "./approvals-rig.js";

// PV-Q1 slice 2 review 1: axis.pages/1 through the real daemon pipeline and served rows, and the compose root's worker lookup.

const C = "axis.pages";
const SHA = "b".repeat(40);
const verifier: IdentityVerifier = {
  verify(att) {
    const [actor, conn, kind] = String(att).split("#");
    return { connectionId: (conn as string).padEnd(22, "_"), windowId: kind === "web" ? "web" : "win-1", actorId: `${actor}-id`, actor: actor as Identity["actor"], trusted: true, clientKind: kind === "web" ? "web" : "desktop" };
  },
};

async function setup(t: TestContext) {
  const db = openDatabase(":memory:");
  const journal = Journal.open(db, { audit: new AuditLog(db) });
  journal.registerProject({ id: "p", path: "/repo/p", displayName: "p", trusted: false, actor: "user" });
  const service = createPagesService({ journal, audit: { append: () => undefined }, random: { bytes: (n) => randomBytes(n) } });
  const trust = new InMemoryTrustRegistry();
  trust.set({ windowId: "win-1" }, true);
  const daemon = new Daemon({ identity: verifier, audit: { append: () => undefined }, registry: protocolRegistry, idempotency: new MemoryIdempotencyStore(), policy: new RuleTablePolicy(trust) });
  daemon.register(C, 1, createPagesHandlers(service));
  const ports: { close(): void }[] = [];
  t.after(() => {
    daemon.stop();
    for (const p of ports) p.close();
    db.close();
  });
  const connect = async (att = "user#conn-1#desktop"): Promise<Client> => {
    const { client, server } = memoryPair();
    ports.push(client);
    const c = new Client(client);
    daemon.accept(server, att);
    client.postMessage({ type: "hello", protocolVersions: [1], contracts: [{ id: C, versions: [1] }] });
    await c.until((m) => m.type !== undefined);
    return c;
  };
  return { journal, service, connect };
}

test("markReviewed and delete are unreachable without the tier-3 challenge: the handler never runs; a worker or web caller is denied by policy", async (t) => {
  const { service, connect } = await setup(t);
  const pageId = service.create({ kind: "user" }, { projectId: "p", title: "Plan", body: "x" }).version.meta.pageId;
  service.update({ kind: "agent", agentId: "w1", projectId: "p", runId: "r", receivedHop: 1 }, { pageId, baseSeq: 1, title: "Plan", body: "agent" });
  const user = await connect();
  const review = await user.call(C, "markReviewed", { pageId, seq: 2 });
  const del = await user.call(C, "delete", { pageId });
  assert.equal(review.ok, false);
  assert.equal(del.ok, false);
  assert.notEqual(review.error?.code, "E_NOT_FOUND", "refused before the handler, not by it");
  assert.equal(service.get({ pageId, seq: 2 }).version.meta.reviewed, false, "not marked");
  assert.equal(service.get({ pageId }).version.meta.seq, 2, "not deleted");
  const ok = await user.call(C, "get", { pageId });
  assert.equal(ok.ok, true, JSON.stringify(ok.error));
  for (const att of ["agent:a1#conn-2#desktop", "user#conn-3#web"]) {
    const c = await connect(att);
    assert.equal((await c.call(C, "get", { pageId })).error?.code, "E_POLICY_DENIED", att);
  }
});

test("journalWorkerOf, the compose root's lookup: a run's live worker and its project; nothing for an archived worker or a run without one", () => {
  const db = openDatabase(":memory:");
  const journal = Journal.open(db, { audit: new AuditLog(db) });
  journal.registerProject({ id: "p", path: "/repo/p", displayName: "p", trusted: false, actor: "user" });
  const w = journal.createWorkspace({ projectId: "p", branch: "axis/a", baseRef: "main", baseSha: SHA, createdBy: "user" }).value;
  const ws = journal.transitionWorkspace(w.id, "READY").id;
  journal.agents.create({ id: "w1", projectId: "p", name: "Planner", launch: { kind: "cli", entryId: "my-cli" }, homeWorkspaceId: ws, groupId: null });
  const withWorker = journal.createRun({ workspaceId: ws, kind: "cli", createdBy: "user", agentId: "w1" } as never).value.id;
  const without = journal.createRun({ workspaceId: ws, kind: "cli", createdBy: "user" }).value.id;
  const of = journalWorkerOf(journal);
  assert.deepEqual(of(withWorker), { agentId: "w1", projectId: "p" });
  assert.equal(of(without), undefined);
  assert.equal(of("nope"), undefined);
  journal.agents.archive("w1");
  assert.equal(of(withWorker), undefined, "archived: no page tools, also for its live runs");
  db.close();
});
