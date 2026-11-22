// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { AuditLog, acquireInstanceLock, openDatabase, type AuditEvent } from "@axis/audit";
import { AGENT_RECORD_ACTION, Journal, type AgentLaunch } from "../src/index.js";

// The agent and group records of PV-G3 over schema version 12: closed refusal reasons, one audit event per write naming
// ids only, and the archives the schema's trigger makes audited in the transition that caused them.

const LOCK_DIR = mkdtempSync(join(tmpdir(), "axis-agents-lock-"));
const LOCK = acquireInstanceLock(LOCK_DIR);
after(() => {
  LOCK.release();
  rmSync(LOCK_DIR, { recursive: true, force: true });
});

const COMPOSER: AgentLaunch = { kind: "composer", connection: "conn", modelId: "model-1", mode: "agent" };
const CLI: AgentLaunch = { kind: "cli", entryId: "my-cli" };

function setup() {
  const db = openDatabase(":memory:");
  const audit = new AuditLog(db);
  const journal = Journal.open(db, { audit });
  for (const [id, path] of [["p1", "/repo/one"], ["p2", "/repo/two"]] as const) journal.registerProject({ id, path, displayName: id, trusted: false, actor: "user" });
  const ws = (projectId: string, ready = true): string => {
    const id = journal.createWorkspace({ projectId, branch: `axis/${Math.random().toString(36).slice(2, 9)}`, baseRef: "HEAD", baseSha: "c".repeat(40), createdBy: "user" }).value.id;
    if (ready) journal.transitionWorkspace(id, "READY");
    return id;
  };
  const events = (): AuditEvent[] => audit.list().filter((e) => e.action === AGENT_RECORD_ACTION);
  return { db, journal, ws, events, agents: journal.agents };
}
const reason = (r: string) => (e: unknown) => (e as { detail?: { reason?: string } }).detail?.reason === r;

test("create: a READY home of the same project, an own group, a free live name and room in the project", () => {
  const { journal, ws, agents, events } = setup();
  const [home, other] = [ws("p1"), ws("p2")];
  const g = agents.createGroup({ id: "g1", projectId: "p1", name: "Backend" });
  agents.createGroup({ id: "g2", projectId: "p2", name: "Other" });
  const a = agents.create({ id: "a1", projectId: "p1", name: "Planner", launch: COMPOSER, homeWorkspaceId: home, groupId: g.id });
  assert.deepEqual({ ...a, createdAt: "", updatedAt: "" }, { id: "a1", projectId: "p1", name: "Planner", launch: COMPOSER, homeWorkspaceId: home, groupId: "g1", archived: false, createdAt: "", updatedAt: "" });
  const base = { projectId: "p1", launch: CLI, homeWorkspaceId: home, groupId: null };
  assert.throws(() => agents.create({ ...base, id: "x1", name: "planner" }), reason("name_taken"));
  assert.throws(() => agents.create({ ...base, id: "x2", name: "N", homeWorkspaceId: "nope" }), reason("not_found"));
  assert.throws(() => agents.create({ ...base, id: "x3", name: "N", homeWorkspaceId: other }), reason("cross_project"));
  assert.throws(() => agents.create({ ...base, id: "x4", name: "N", groupId: "g2" }), reason("cross_project"));
  assert.throws(() => agents.create({ ...base, id: "x5", name: "N", groupId: "nope" }), reason("not_found"));
  assert.throws(() => agents.create({ ...base, id: "x6", name: "N", homeWorkspaceId: ws("p1", false) }), reason("home_unavailable"), "a CREATING workspace is not a home to pick");
  const finished = ws("p1");
  journal.transitionWorkspace(finished, "FINALISED", { outcome: "merged" });
  assert.throws(() => agents.create({ ...base, id: "x7", name: "N", homeWorkspaceId: finished }), reason("home_unavailable"));
  agents.create({ ...base, id: "c1", name: "Helper" });
  const created = events().filter((e) => (e.payload as { field?: string }).field === "create");
  assert.equal(created.length, 2);
  assert.deepEqual(created[0]!.payload, { field: "create", agentId: "a1", projectId: "p1", workspaceId: home, kind: "composer", groupId: "g1" });
  assert.equal(created[0]!.actor, "user");
  assert.equal(JSON.stringify(events()).includes("Planner"), false, "no name the user typed is in the log");
});

test("create stops at the per-project agent cap, archived agents included", () => {
  const { ws, agents, db } = setup();
  const home = ws("p1");
  db.exec("CREATE TEMP TABLE n(i INTEGER)");
  for (let i = 0; i < 499; i++) agents.create({ id: `a${i}`, projectId: "p1", name: `n${i}`, launch: CLI, homeWorkspaceId: home, groupId: null });
  agents.archive("a0");
  agents.create({ id: "last", projectId: "p1", name: "last", launch: CLI, homeWorkspaceId: home, groupId: null });
  assert.throws(() => agents.create({ id: "over", projectId: "p1", name: "over", launch: CLI, homeWorkspaceId: home, groupId: null }), reason("limit_reached"));
});

test("rename, launch, archive, restore and assign: changed only when something changes, each audited once", () => {
  const { journal, ws, agents, events } = setup();
  const home = ws("p1");
  agents.createGroup({ id: "g1", projectId: "p1", name: "G" });
  agents.createGroup({ id: "g9", projectId: "p2", name: "G" });
  agents.create({ id: "a1", projectId: "p1", name: "A", launch: COMPOSER, homeWorkspaceId: home, groupId: null });
  agents.create({ id: "b1", projectId: "p1", name: "B", launch: CLI, homeWorkspaceId: home, groupId: null });
  const before = events().length;
  assert.equal(agents.rename("a1", "A").changed, false);
  assert.throws(() => agents.rename("a1", "b"), reason("name_taken"));
  assert.equal(agents.rename("a1", "a").changed, true, "its own name in another case is free");
  assert.throws(() => agents.setLaunch("a1", CLI), reason("kind_changed"));
  assert.equal(agents.setLaunch("a1", COMPOSER).changed, false);
  assert.deepEqual(agents.setLaunch("a1", { ...COMPOSER, mode: "ask" }).value.launch, { ...COMPOSER, mode: "ask" });
  assert.deepEqual(agents.setLaunch("b1", { kind: "cli", entryId: "other" }).value.launch, { kind: "cli", entryId: "other" });
  assert.throws(() => agents.assign("a1", "g9"), reason("cross_project"));
  assert.equal(agents.assign("a1", "g1").value.groupId, "g1");
  assert.equal(agents.assign("a1", "g1").changed, false);
  assert.equal(agents.assign("a1", null).value.groupId, null);
  assert.equal(agents.archive("b1").changed, true);
  assert.equal(agents.archive("b1").changed, false);
  for (const write of [() => agents.rename("b1", "Z"), () => agents.setLaunch("b1", CLI), () => agents.assign("b1", "g1")]) assert.throws(write, reason("archived"));
  agents.create({ id: "c1", projectId: "p1", name: "B", launch: CLI, homeWorkspaceId: home, groupId: null });
  assert.throws(() => agents.restore("b1"), reason("name_taken"));
  agents.rename("c1", "C");
  assert.equal(agents.restore("b1").value.archived, false);
  assert.equal(agents.restore("b1").changed, false);
  for (const op of [() => agents.rename("zz", "Z"), () => agents.archive("zz"), () => agents.restore("zz"), () => agents.assign("zz", null)]) assert.throws(op, reason("not_found"));
  const fields = events().slice(before).map((e) => (e.payload as { field: string }).field);
  assert.deepEqual(fields, ["rename", "launch", "launch", "assign", "assign", "archive", "create", "rename", "restore"]);
  assert.equal(journal.agents.get("b1")?.archived, false);
});

test("groups: appended in order, renamed, reordered only as a full permutation, deleted with their agents ungrouped", () => {
  const { ws, agents, events } = setup();
  const home = ws("p1");
  for (const id of ["g1", "g2", "g3"]) agents.createGroup({ id, projectId: "p1", name: id });
  assert.deepEqual(agents.listGroups("p1").map((g) => [g.id, g.order]), [["g1", 0], ["g2", 1], ["g3", 2]]);
  assert.equal(agents.renameGroup("g1", "g1").changed, false);
  assert.equal(agents.renameGroup("g1", "Front").value.name, "Front");
  for (const order of [["g1", "g2"], ["g1", "g2", "g2"], ["g1", "g2", "gx"], ["g1", "g2", "g3", "g4"]]) assert.throws(() => agents.reorderGroups("p1", order), reason("order_mismatch"), order.join());
  assert.deepEqual(agents.reorderGroups("p1", ["g3", "g1", "g2"]).map((g) => g.id), ["g3", "g1", "g2"]);
  agents.create({ id: "a1", projectId: "p1", name: "A", launch: CLI, homeWorkspaceId: home, groupId: "g1" });
  agents.create({ id: "a2", projectId: "p1", name: "B", launch: CLI, homeWorkspaceId: home, groupId: "g1" });
  agents.archive("a2");
  assert.deepEqual(agents.deleteGroup("g1"), ["a1", "a2"]);
  assert.deepEqual([agents.get("a1")?.groupId, agents.get("a1")?.archived, agents.get("a2")?.archived], [null, false, true]);
  assert.throws(() => agents.deleteGroup("g1"), reason("not_found"));
  assert.throws(() => agents.renameGroup("g1", "x"), reason("not_found"));
  const last = events().at(-1)!;
  assert.deepEqual(last.payload, { field: "group.delete", groupId: "g1", projectId: "p1", count: "2" });
});

test("the group cap: 100 groups, then limit_reached", () => {
  const { agents } = setup();
  for (let i = 0; i < 100; i++) agents.createGroup({ id: `g${i}`, projectId: "p1", name: `g${i}` });
  assert.throws(() => agents.createGroup({ id: "g100", projectId: "p1", name: "x" }), reason("limit_reached"));
  agents.createGroup({ id: "h0", projectId: "p2", name: "x" });
});

test("a home leaving CREATING or READY archives its live agents, audited by the transition's actor; recovery too", () => {
  const { db, journal, ws, agents, events } = setup();
  const [home, other] = [ws("p1"), ws("p1")];
  agents.create({ id: "a1", projectId: "p1", name: "A", launch: CLI, homeWorkspaceId: home, groupId: null });
  agents.create({ id: "a2", projectId: "p1", name: "B", launch: CLI, homeWorkspaceId: home, groupId: null });
  agents.create({ id: "a3", projectId: "p1", name: "C", launch: CLI, homeWorkspaceId: other, groupId: null });
  agents.archive("a2");
  const before = events().length;
  journal.transitionWorkspace(home, "REMOVING", { actor: "user" });
  const archived = events().slice(before);
  assert.deepEqual(archived.map((e) => [e.actor, e.target, e.payload]), [["user", "agent:a1", { field: "archive", agentId: "a1", workspaceId: home, reason: "home_not_live" }]]);
  journal.transitionWorkspace(home, "REMOVED");
  assert.equal(events().length, before + 1, "no second event for agents already archived");
  journal.transitionWorkspace(other, "FINALISED", { outcome: "merged" });
  assert.deepEqual(events().at(-1)!.actor, "daemon");
  assert.equal(agents.get("a3")?.archived, true);
  assert.throws(() => agents.restore("a3"), reason("home_unavailable"), "a finalised home cannot take its agent back");
  assert.throws(() => agents.restore("a1"), reason("home_unavailable"), "nor a removed one");
  // A CREATING home that recovery fails: its agents are archived and audited by the daemon.
  const creating = ws("p1", false);
  db.prepare("INSERT INTO agents (id, project_id, name, kind, cli_entry_id, home_workspace_id, created_by, created_at, updated_at) VALUES ('a4', 'p1', 'D', 'cli', 'e', ?, 'user', 't', 't')").run(creating);
  journal.recover(LOCK);
  assert.deepEqual([events().at(-1)!.actor, events().at(-1)!.target, (events().at(-1)!.payload as { reason: string }).reason], ["daemon", "agent:a4", "home_not_live"]);
  assert.equal(agents.get("a4")?.archived, true);
});

test("list: live agents by default, archived on request, per project", () => {
  const { ws, agents } = setup();
  const [h1, h2] = [ws("p1"), ws("p2")];
  agents.create({ id: "a1", projectId: "p1", name: "A", launch: CLI, homeWorkspaceId: h1, groupId: null });
  agents.create({ id: "a2", projectId: "p1", name: "B", launch: CLI, homeWorkspaceId: h1, groupId: null });
  agents.create({ id: "a3", projectId: "p2", name: "A", launch: CLI, homeWorkspaceId: h2, groupId: null });
  agents.archive("a2");
  assert.deepEqual(agents.list("p1").map((a) => a.id), ["a1"]);
  assert.deepEqual(agents.list("p1", true).map((a) => a.id).sort(), ["a1", "a2"]);
  assert.deepEqual(agents.list("p2").map((a) => a.id), ["a3"]);
});
