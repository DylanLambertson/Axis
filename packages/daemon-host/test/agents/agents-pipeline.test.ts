// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { AuditLog, openDatabase } from "@axis/audit";
import { Daemon, MemoryIdempotencyStore, memoryPair, protocolRegistry, type Identity, type IdentityVerifier } from "@axis/daemon";
import { Journal } from "@axis/journal";
import { createAgentsService } from "../../src/agents/service.js";
import { createAgentsHandlers } from "../../src/handlers/agents.js";
import { createAgentStart } from "../../src/agents/start.js";
import { InMemoryTrustRegistry, RuleTablePolicy } from "../../src/policy/index.js";
import { ProjectMutex } from "../../src/worktrees/project-mutex.js";
import { Client, newKey } from "../approvals-rig.js";

// axis.agents/1 and axis.agent-groups/1 through the real daemon pipeline (PV-G3): the served rows, the idempotency store's
// replay of `create` (same key: the first agent, no second worktree), and policy refusals for any caller but the user's desktop.

const A = "axis.agents";
const G = "axis.agent-groups";
const verifier: IdentityVerifier = {
  verify(att) {
    const [actor, conn, kind] = String(att).split("#");
    return { connectionId: (conn as string).padEnd(22, "_"), windowId: kind === "web" ? "web" : "win-1", actorId: `${actor}-id`, actor: actor as Identity["actor"], trusted: true, clientKind: kind === "web" ? "web" : "desktop" };
  },
};

function setup(t: TestContext) {
  const db = openDatabase(":memory:");
  const journal = Journal.open(db, { audit: new AuditLog(db) });
  journal.registerProject({ id: "p1", path: "/repo/p1", displayName: "p1", trusted: false, actor: "user" });
  const made: string[] = [];
  const worktrees = {
    create: async (req: { projectId: string; name: string }) => {
      made.push(req.name);
      const id = journal.createWorkspace({ projectId: req.projectId, branch: `axis/${req.name}-${made.length}`, baseRef: "HEAD", baseSha: "c".repeat(40), createdBy: "user" }).value.id;
      journal.transitionWorkspace(id, "READY");
      return { id } as never;
    },
  };
  const trust = new InMemoryTrustRegistry();
  trust.set({ windowId: "win-1" }, true);
  let n = 0;
  const composerStarts: string[] = [];
  const start = createAgentStart({
    journal,
    startCli: async () => Promise.reject(new Error("unused")),
    providerFor: (c) => (c === "conn" ? "mock" : undefined),
    startComposer: async (req) => {
      composerStarts.push(req.prompt);
      req.recheck?.();
      const run = journal.createRun({ workspaceId: req.workspaceId, kind: "composer", createdBy: "user", ...(req.worker === undefined ? {} : { agentId: req.worker }) }).value;
      return { run: { runId: run.id }, replayed: false };
    },
  });
  const handlers = createAgentsHandlers(createAgentsService({ journal, worktrees, mutex: new ProjectMutex(), trust, newId: () => `id${++n}` }), start);
  const daemon = new Daemon({ identity: verifier, audit: { append: () => undefined }, registry: protocolRegistry, idempotency: new MemoryIdempotencyStore(), policy: new RuleTablePolicy(trust) });
  daemon.register(A, 1, handlers.agents);
  daemon.register(G, 1, handlers.groups);
  const ports: { close(): void }[] = [];
  t.after(() => {
    daemon.stop();
    for (const p of ports) p.close();
    db.close();
  });
  return {
    journal,
    made,
    composerStarts,
    async connect(att = "user#conn-1#desktop"): Promise<Client> {
      const { client, server } = memoryPair();
      ports.push(client);
      const c = new Client(client);
      daemon.accept(server, att);
      client.postMessage({ type: "hello", protocolVersions: [1], contracts: [{ id: A, versions: [1] }, { id: G, versions: [1] }] });
      await c.until((m) => m.type !== undefined);
      return c;
    },
  };
}

const CREATE = { projectId: "p1", name: "Planner", launch: { kind: "cli", entryId: "my-cli" }, home: { new: { name: "planner" } } };

test("a create retried with its key replays the first agent and makes no second worktree; a new key makes a new one", async (t) => {
  const { connect, made, journal } = setup(t);
  const user = await connect();
  const key = newKey();
  const first = await user.call(A, "create", CREATE, key);
  assert.equal(first.ok, true, JSON.stringify(first.error));
  const again = await user.call(A, "create", CREATE, key);
  assert.deepEqual(again.result, first.result, "the replay is the first result");
  assert.deepEqual(made, ["planner"], "one worktree");
  assert.equal(journal.agents.list("p1").length, 1);
  const other = await user.call(A, "create", { ...CREATE, name: "Planner 2" }, newKey());
  assert.equal(other.ok, true);
  assert.deepEqual(made, ["planner", "planner"]);
  assert.equal((await user.call(A, "create", CREATE)).error?.code, "E_INVALID_ARGUMENT", "create needs an idempotency key");
});

test("the served rows refuse an agent caller and a web client before any handler runs", async (t) => {
  const { connect, made, journal } = setup(t);
  for (const att of ["agent:a1#conn-2#desktop", "user#conn-3#web"]) {
    const c = await connect(att);
    assert.equal((await c.call(A, "create", CREATE, newKey())).error?.code, "E_POLICY_DENIED", att);
    assert.equal((await c.call(A, "list", { projectId: "p1" })).error?.code, "E_POLICY_DENIED", att);
    assert.equal((await c.call(G, "create", { projectId: "p1", name: "G" }, newKey())).error?.code, "E_POLICY_DENIED", att);
  }
  assert.deepEqual([made, journal.agents.listGroups("p1")], [[], []], "nothing was made or written");
});

test("a composer worker's start retried with its key replays the first run and starts no second one", async (t) => {
  const { connect, composerStarts, journal } = setup(t);
  const user = await connect();
  const home = (await user.call(A, "create", { projectId: "p1", name: "Planner", launch: { kind: "composer", connection: "conn", modelId: "m", mode: "agent" }, home: { new: { name: "planner" } } }, newKey())).result as { agent: { id: string } };
  const key = newKey();
  const first = await user.call(A, "start", { agentId: home.agent.id, input: { prompt: "go" } }, key);
  assert.equal(first.ok, true, JSON.stringify(first.error));
  const again = await user.call(A, "start", { agentId: home.agent.id, input: { prompt: "go" } }, key);
  assert.deepEqual(again.result, first.result);
  assert.deepEqual(composerStarts, ["go"], "one start for one key");
  assert.equal((journal.listRuns() as unknown[]).length, 1);
  assert.equal((await user.call(A, "start", { agentId: home.agent.id, input: { prompt: "go" } })).error?.code, "E_INVALID_ARGUMENT", "a start needs an idempotency key");
});
