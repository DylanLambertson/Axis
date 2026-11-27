// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { AuditLog, openDatabase } from "@axis/audit";
import { Journal } from "@axis/journal";
import { MAX_SETTINGS_AGENTS } from "@axis/protocol";
import { journalAgentOf, journalAgentsDirectory } from "../../src/agents/directory.js";
import { createMessagingBinding, hostMessagingDeps } from "../../src/messages/binding.js";
import { MessageRefusal } from "../../src/messages/policy.js";

// The messaging directory over the journal's agents (PV-G3 slice 2): live only, groups expanded to their live members
// (bounded), read at each call; a run's agent is what the run recorded at its start (none until PV-G4).

const CLI = { kind: "cli", entryId: "e" } as const;
const COMPOSER = { kind: "composer", connection: "c", modelId: "m", mode: "agent" } as const;

function setup() {
  const db = openDatabase(":memory:");
  const journal = Journal.open(db, { audit: new AuditLog(db) });
  for (const id of ["p1", "p2"]) journal.registerProject({ id, path: `/repo/${id}`, displayName: id, trusted: false, actor: "user" });
  const ws = (projectId: string): string => {
    const id = journal.createWorkspace({ projectId, branch: `axis/${Math.random().toString(36).slice(2, 9)}`, baseRef: "HEAD", baseSha: "c".repeat(40), createdBy: "user" }).value.id;
    journal.transitionWorkspace(id, "READY");
    return id;
  };
  const add = (id: string, projectId: string, home: string, groupId: string | null = null, launch: typeof CLI | typeof COMPOSER = COMPOSER) =>
    journal.agents.create({ id, projectId, name: id, launch, homeWorkspaceId: home, groupId });
  return { db, journal, ws, add, dir: journalAgentsDirectory(journal) };
}

test("agents: live only, with project, group and kind; an archived or unknown agent is unknown", () => {
  const { journal, ws, add, dir } = setup();
  const home = ws("p1");
  journal.agents.createGroup({ id: "g1", projectId: "p1", name: "G" });
  add("a1", "p1", home, "g1");
  add("c1", "p1", home, null, CLI);
  assert.deepEqual(dir.agent("a1"), { agentId: "a1", projectId: "p1", groupId: "g1", kind: "composer" });
  assert.deepEqual(dir.agent("c1"), { agentId: "c1", projectId: "p1", groupId: null, kind: "cli" });
  assert.equal(dir.agent("nope"), undefined);
  journal.agents.archive("a1");
  assert.equal(dir.agent("a1"), undefined, "archived: neither addressable nor delivered to");
  journal.agents.restore("a1");
  assert.equal(dir.agent("a1")?.agentId, "a1", "read at each call: a restore takes effect at once");
  assert.equal(dir.project("p1"), true);
  assert.equal(dir.project("px"), false);
});

test("groups expand to their live members in id order, bounded; projects list live agents, bounded", () => {
  const { journal, ws, add, dir } = setup();
  const home = ws("p1");
  journal.agents.createGroup({ id: "g1", projectId: "p1", name: "G" });
  journal.agents.createGroup({ id: "g2", projectId: "p1", name: "H" });
  for (const id of ["b", "a", "c"]) add(id, "p1", home, "g1");
  add("d", "p1", home, "g2");
  journal.agents.archive("c");
  assert.deepEqual(dir.group("g1"), { groupId: "g1", projectId: "p1", members: ["a", "b"] });
  assert.deepEqual(dir.group("g2")?.members, ["d"]);
  assert.equal(dir.group("nope"), undefined);
  journal.agents.createGroup({ id: "g9", projectId: "p2", name: "Elsewhere" });
  assert.deepEqual(dir.group("g9"), { groupId: "g9", projectId: "p2", members: [] }, "a group carries its own project");
  assert.deepEqual(dir.agents("p1"), [
    { agentId: "a", projectId: "p1", groupId: "g1", kind: "composer" },
    { agentId: "b", projectId: "p1", groupId: "g1", kind: "composer" },
    { agentId: "d", projectId: "p1", groupId: "g2", kind: "composer" },
  ], "live agents in id order, not creation order");
  assert.deepEqual(dir.agents("p2"), []);
  for (let i = 0; i < MAX_SETTINGS_AGENTS + 2; i++) add(`m${String(i).padStart(3, "0")}`, "p1", home, "g2");
  assert.equal(dir.group("g2")?.members.length, MAX_SETTINGS_AGENTS);
  assert.equal(dir.agents("p1").length, MAX_SETTINGS_AGENTS);
});

test("a run's agent is the one it recorded at its start; a run of no agent, or an unknown run, has none", () => {
  const { db, journal, ws, add } = setup();
  const home = ws("p1");
  add("a1", "p1", home);
  const agentOf = journalAgentOf(journal);
  const plain = journal.createRun({ workspaceId: home, kind: "composer", createdBy: "user" }).value.id;
  db.prepare("INSERT INTO agent_runs (id, workspace_id, kind, state, created_at, updated_at, agent_id) VALUES ('r-a', ?, 'composer', 'QUEUED', 't', 't', 'a1')").run(home);
  assert.equal(agentOf("r-a"), "a1");
  assert.equal(agentOf(plain), undefined);
  assert.equal(agentOf("nope"), undefined);
});

test("over the real message service: the user reaches a live agent and a group's live members; an archived agent is refused", async () => {
  const { journal, ws, add } = setup();
  const home = ws("p1");
  journal.agents.createGroup({ id: "g1", projectId: "p1", name: "G" });
  add("a1", "p1", home, "g1");
  add("a2", "p1", home, "g1");
  add("a3", "p1", home, "g1");
  journal.agents.archive("a3");
  const m = createMessagingBinding({ journal, audit: { append: () => undefined }, random: { bytes: (n) => randomBytes(n) }, monotonic: () => 0, scan: async () => [], holdsSecret: () => false, directory: journalAgentsDirectory(journal) });
  const user = { kind: "user" } as const;
  const one = await m.service.send(user, { recipients: [{ agent: "a1" }], body: { format: "text", text: "hello" } });
  assert.deepEqual(one.message.expanded.map((r) => (r as { agentId?: string }).agentId), ["a1"]);
  const grouped = await m.service.send(user, { recipients: [{ group: "g1" }], body: { format: "text", text: "all" } });
  assert.deepEqual(grouped.message.expanded.map((r) => (r as { agentId?: string }).agentId).sort(), ["a1", "a2"], "the archived member is not expanded");
  await assert.rejects(m.service.send(user, { recipients: [{ agent: "a3" }], body: { format: "text", text: "x" } }), (e: unknown) => e instanceof MessageRefusal && e.reason === "recipient_refused");
});

test("the host's messaging deps carry the journal directory and the journal's run agent", () => {
  const { journal, ws, add } = setup();
  add("a1", "p1", ws("p1"));
  const deps = hostMessagingDeps({ journal, audit: { append: () => undefined }, monotonic: () => 0, scan: async () => [], holdsSecret: () => false, logger: undefined });
  assert.deepEqual(deps.directory?.agent("a1"), { agentId: "a1", projectId: "p1", groupId: null, kind: "composer" });
  assert.equal(deps.agentOf?.("no-run"), undefined);
});
