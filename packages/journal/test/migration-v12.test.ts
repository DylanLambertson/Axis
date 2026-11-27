// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AuditLog, openDatabase, schemaVersion, type DatabaseSync } from "@axis/audit";
import { JOURNAL_SCHEMA_VERSION, Journal, NAME_REFUSED_RANGES } from "../src/index.js";

// Agents and agent groups (ticket PV-G1, ADR 0006): schema version 12. Every constraint has a refusing case here, and
// the cases sit next to the closest accepted value, so loosening any check fails a test.

const T = "2026-11-21T00:00:00.000Z";
interface Fixture { readonly db: DatabaseSync; readonly journal: Journal; readonly ws: Record<"a" | "b" | "other", string> }

function workspace(journal: Journal, projectId: string, ready = true): string {
  const branch = `axis/w${Math.random().toString(36).slice(2, 8)}`;
  const id = journal.createWorkspace({ projectId, branch, baseRef: "HEAD", baseSha: "c".repeat(40), createdBy: "user" }).value.id;
  if (ready) journal.transitionWorkspace(id, "READY");
  return id;
}
function setup(): Fixture {
  const db = openDatabase(":memory:");
  const journal = Journal.open(db, { audit: new AuditLog(db) });
  journal.registerProject({ id: "p1", path: "/repo/one", displayName: "One", trusted: false, actor: "user" });
  journal.registerProject({ id: "p2", path: "/repo/two", displayName: "Two", trusted: false, actor: "user" });
  return { db, journal, ws: { a: workspace(journal, "p1"), b: workspace(journal, "p1"), other: workspace(journal, "p2") } };
}
type Row = Record<string, string | number | null>;
function insert(db: DatabaseSync, table: string, row: Row): void {
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...Object.values(row));
}
const group = (over: Row = {}): Row => ({ id: "g1", project_id: "p1", name: "Backend", ord: 0, created_by: "user", created_at: T, updated_at: T, ...over });
const composer = (home: string, over: Row = {}): Row => ({
  id: "a1", project_id: "p1", name: "Planner", kind: "composer", connection: "anthropic-main", model_id: "claude-x", default_mode: "agent",
  home_workspace_id: home, created_by: "user", created_at: T, updated_at: T, ...over,
});
const cli = (home: string, over: Row = {}): Row => ({
  id: "c1", project_id: "p1", name: "Shell helper", kind: "cli", cli_entry_id: "my-cli.v2", home_workspace_id: home,
  created_by: "user", created_at: T, updated_at: T, ...over,
});
const agent = (db: DatabaseSync, agentId: string): Row => db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as Row;

test("version 12 applies (13 follows it), and an agent and a group are stored as given", () => {
  const { db, ws } = setup();
  assert.equal(schemaVersion(db, "journal"), JOURNAL_SCHEMA_VERSION);
  assert.ok(JOURNAL_SCHEMA_VERSION >= 12);
  insert(db, "agent_groups", group());
  insert(db, "agents", composer(ws.a, { group_id: "g1" }));
  insert(db, "agents", cli(ws.b));
  assert.deepEqual({ ...agent(db, "a1") }, {
    id: "a1", project_id: "p1", name: "Planner", kind: "composer", cli_entry_id: null, connection: "anthropic-main", model_id: "claude-x",
    default_mode: "agent", home_workspace_id: ws.a, group_id: "g1", archived: 0, archived_at: null, created_by: "user", created_at: T, updated_at: T,
  });
  assert.equal(agent(db, "c1")["kind"], "cli");
  db.close();
});

test("ids and names: journal-id format, 1 to 64 characters, no edge space, control or bidirectional character", () => {
  const { db, ws } = setup();
  for (const [i, gid] of ["A", "9_x-Y", "a".repeat(64)].entries()) insert(db, "agent_groups", group({ id: gid, ord: i }));
  for (const gid of ["", "-a", "_a", "a.b", "a b", "a:b", "a".repeat(65), "é"]) {
    assert.throws(() => insert(db, "agent_groups", group({ id: gid })), /CHECK/, `group id ${JSON.stringify(gid)}`);
    assert.throws(() => insert(db, "agents", composer(ws.a, { id: gid })), /CHECK/, `agent id ${JSON.stringify(gid)}`);
  }
  const names = ["x", "Ünïcødé ok", "n".repeat(64), "inner  spaces"];
  names.forEach((n, i) => insert(db, "agents", composer(ws.a, { id: `n${i}`, name: n })));
  for (const [i, n] of ["", " lead", "trail ", "n".repeat(65), "a\u0000b", "a\tb"].entries()) {
    assert.throws(() => insert(db, "agents", composer(ws.a, { id: `b${i}`, name: n })), /CHECK/, `agent name ${JSON.stringify(n)}`);
    assert.throws(() => insert(db, "agent_groups", group({ id: `b${i}`, name: n })), /CHECK/, `group name ${JSON.stringify(n)}`);
  }
  // The refused set, written out independently: every range's ends are refused and the code points just outside are not.
  const EXPECTED: readonly (number | readonly [number, number])[] = [
    [0x1, 0x1f], [0x7f, 0x9f], 0xa0, 0xad, [0x600, 0x605], 0x61c, 0x6dd, 0x70f, [0x890, 0x891], 0x8e2, 0x180e,
    [0x2000, 0x200f], [0x2028, 0x202f], [0x205f, 0x2064], [0x2066, 0x206f], 0xfeff, [0xfff9, 0xfffb], 0x110bd, 0x110cd,
    [0x13430, 0x1343f], [0x1bca0, 0x1bca3], [0x1d173, 0x1d17a], 0xe0001, [0xe0020, 0xe007f],
  ];
  assert.deepEqual(NAME_REFUSED_RANGES, EXPECTED);
  const spans = EXPECTED.map((r) => (typeof r === "number" ? [r, r] : r));
  const refused = (cp: number): boolean => spans.some(([a, b]) => cp >= a! && cp <= b!);
  let k = 0;
  const probes = new Set(spans.flatMap(([a, b]) => [a!, b!, a! - 1, b! + 1]));
  probes.delete(0);
  for (const cp of probes) {
    {
      const name = `a${String.fromCodePoint(cp)}b`;
      const row = composer(ws.a, { id: `k${k++}`, name });
      if (refused(cp)) {
        assert.throws(() => insert(db, "agents", row), /CHECK/, `U+${cp.toString(16)} is refused`);
        assert.throws(() => insert(db, "agent_groups", group({ id: `k${k++}`, name })), /CHECK/, `U+${cp.toString(16)} is refused in a group`);
      } else {
        insert(db, "agents", row);
      }
    }
  }
  db.close();
});

test("groups: order 0 to 9999, user-created, in one existing project; id, project and creation time are fixed", () => {
  const { db } = setup();
  insert(db, "agent_groups", group({ ord: 9999 }));
  insert(db, "agent_groups", group({ id: "g0", ord: 0 }));
  insert(db, "agent_groups", group({ id: "g2", ord: 0, name: "Backend" }));
  assert.throws(() => insert(db, "agent_groups", group({ id: "g3", ord: -1 })), /CHECK/);
  assert.throws(() => insert(db, "agent_groups", group({ id: "g3", ord: 10000 })), /CHECK/);
  assert.throws(() => insert(db, "agent_groups", group({ id: "g3", created_by: "agent:a1" })), /CHECK/);
  assert.throws(() => insert(db, "agent_groups", group({ id: "g3", created_by: "daemon" })), /CHECK/);
  assert.throws(() => insert(db, "agent_groups", group({ id: "g3", project_id: "nope" })), /FOREIGN KEY/);
  assert.throws(() => insert(db, "agent_groups", group({ id: "g1" })), /a group is inserted once/);
  db.prepare("UPDATE agent_groups SET name = 'Front', ord = 5, updated_at = 'later' WHERE id = 'g1'").run();
  for (const set of ["id = 'g9'", "project_id = 'p2'", "created_at = 'later'"]) {
    assert.throws(() => db.prepare(`UPDATE agent_groups SET ${set} WHERE id = 'g1'`).run(), /keeps its id, project and creation time/, set);
  }
  assert.throws(() => db.prepare("UPDATE agent_groups SET created_by = 'daemon' WHERE id = 'g1'").run(), /CHECK/);
  db.close();
});

test("launch: a CLI agent names only an entry id, a composer agent only a connection, model and mode", () => {
  const { db, ws } = setup();
  let n = 0;
  const tryInsert = (row: Row): void => insert(db, "agents", { ...row, id: `x${n++}`, name: `x${n}` });
  tryInsert(cli(ws.a, { cli_entry_id: "a" }));
  tryInsert(cli(ws.a, { cli_entry_id: "0" + "z".repeat(63) }));
  tryInsert(composer(ws.a, { connection: "c", model_id: "!~", default_mode: "ask" }));
  tryInsert(composer(ws.a, { connection: "a".repeat(64), model_id: "m".repeat(256), default_mode: "edit" }));
  const refused: Row[] = [
    cli(ws.a, { cli_entry_id: null }), cli(ws.a, { connection: "c" }), cli(ws.a, { model_id: "m" }), cli(ws.a, { default_mode: "ask" }),
    composer(ws.a, { connection: null }), composer(ws.a, { model_id: null }), composer(ws.a, { default_mode: null }), composer(ws.a, { cli_entry_id: "e" }),
    cli(ws.a, { cli_entry_id: "" }), cli(ws.a, { cli_entry_id: "Upper" }), cli(ws.a, { cli_entry_id: ".x" }), cli(ws.a, { cli_entry_id: "a/b" }),
    cli(ws.a, { cli_entry_id: "a".repeat(65) }), composer(ws.a, { connection: "" }), composer(ws.a, { connection: "Anth" }),
    composer(ws.a, { connection: "-x" }), composer(ws.a, { connection: "a b" }), composer(ws.a, { connection: "a".repeat(65) }),
    composer(ws.a, { model_id: "" }), composer(ws.a, { model_id: "a b" }), composer(ws.a, { model_id: "m".repeat(257) }), composer(ws.a, { model_id: "é" }),
    composer(ws.a, { default_mode: "yolo" }), composer(ws.a, { kind: "planner" }), cli(ws.a, { created_by: "agent:a1" }),
  ];
  for (const row of refused) assert.throws(() => tryInsert(row), /CHECK/, JSON.stringify(row));
  db.close();
});

test("an agent, its home workspace and its group belong to one project", () => {
  const { db, ws } = setup();
  insert(db, "agent_groups", group());
  insert(db, "agent_groups", group({ id: "g2", project_id: "p2" }));
  assert.throws(() => insert(db, "agents", composer(ws.other)), /FOREIGN KEY/, "a home in another project");
  assert.throws(() => insert(db, "agents", composer(ws.a, { group_id: "g2" })), /FOREIGN KEY/, "a group of another project");
  assert.throws(() => insert(db, "agents", composer(ws.a, { group_id: "none" })), /FOREIGN KEY/);
  assert.throws(() => insert(db, "agents", composer("no-such-workspace")), /FOREIGN KEY/);
  assert.throws(() => insert(db, "agents", composer(ws.a, { project_id: "nope" })), /FOREIGN KEY/);
  insert(db, "agents", composer(ws.other, { project_id: "p2", group_id: "g2" }));
  insert(db, "agents", composer(ws.a, { id: "a2", group_id: "g1" }));
  assert.throws(() => db.prepare("UPDATE agents SET group_id = 'g2' WHERE id = 'a2'").run(), /FOREIGN KEY/);
  db.prepare("UPDATE agents SET group_id = NULL WHERE id = 'a2'").run();
  db.close();
});

test("an agent keeps its id, project, kind, home and creation time, stays user-created, and is never deleted", () => {
  const { db, ws } = setup();
  insert(db, "agent_groups", group());
  insert(db, "agents", composer(ws.a));
  db.prepare("UPDATE agents SET name = 'Renamed', group_id = 'g1', connection = 'other', model_id = 'm2', default_mode = 'ask', updated_at = 'later' WHERE id = 'a1'").run();
  for (const set of ["id = 'a9'", "project_id = 'p2'", "kind = 'cli', cli_entry_id = 'e', connection = NULL, model_id = NULL, default_mode = NULL",
    `home_workspace_id = '${ws.b}'`, "created_at = 'later'"]) {
    assert.throws(() => db.prepare(`UPDATE agents SET ${set} WHERE id = 'a1'`).run(), /keeps its id, project, kind, home and creation time/, set);
  }
  assert.throws(() => db.prepare("UPDATE agents SET created_by = 'agent:a1' WHERE id = 'a1'").run(), /CHECK/);
  assert.throws(() => db.prepare("DELETE FROM agents WHERE id = 'a1'").run(), /archived, never deleted/);
  db.close();
});

test("a live name is unique in its project, ignoring ASCII case; archived agents free it; archived_at goes with archived", () => {
  const { db, ws } = setup();
  insert(db, "agents", composer(ws.a));
  assert.throws(() => insert(db, "agents", cli(ws.b, { name: "Planner" })), /UNIQUE/);
  assert.throws(() => insert(db, "agents", cli(ws.b, { name: "planner" })), /UNIQUE/, "ASCII case is folded");
  assert.throws(() => insert(db, "agents", cli(ws.b, { name: "PLANNER" })), /UNIQUE/);
  insert(db, "agents", cli(ws.b, { name: "Plänner" }));
  insert(db, "agents", cli(ws.b, { id: "c9", name: "PLÄNNER" })); // only ASCII is folded
  insert(db, "agents", composer(ws.other, { id: "a2", project_id: "p2" }));
  assert.throws(() => db.prepare("UPDATE agents SET archived = 1 WHERE id = 'a1'").run(), /CHECK/);
  assert.throws(() => db.prepare("UPDATE agents SET archived_at = 'x' WHERE id = 'a1'").run(), /CHECK/);
  assert.throws(() => db.prepare("UPDATE agents SET archived = 2, archived_at = 'x' WHERE id = 'a1'").run(), /CHECK/);
  assert.throws(() => db.prepare("UPDATE agents SET archived = 2 WHERE id = 'a1'").run(), /CHECK/);
  db.prepare("UPDATE agents SET archived = 1, archived_at = 'then' WHERE id = 'a1'").run();
  insert(db, "agents", cli(ws.b, { id: "c2", name: "Planner" }));
  assert.throws(() => db.prepare("UPDATE agents SET archived = 0, archived_at = NULL WHERE id = 'a1'").run(), /UNIQUE/);
  db.prepare("UPDATE agents SET name = 'Planner 1', archived = 0, archived_at = NULL WHERE id = 'a1'").run();
  db.close();
});

test("deleting a group ungroups its agents and archives none of them", () => {
  const { db, ws } = setup();
  insert(db, "agent_groups", group());
  insert(db, "agent_groups", group({ id: "g2", name: "Other" }));
  insert(db, "agents", composer(ws.a, { group_id: "g1" }));
  insert(db, "agents", cli(ws.b, { group_id: "g2" }));
  db.prepare("DELETE FROM agent_groups WHERE id = 'g1'").run();
  assert.deepEqual([agent(db, "a1")["group_id"], agent(db, "a1")["archived"], agent(db, "c1")["group_id"]], [null, 0, "g2"]);
  db.close();
});

test("a new agent needs a home that is being created or ready; a home going away archives its live agents", () => {
  const { db, journal, ws } = setup();
  const creating = workspace(journal, "p1", false);
  insert(db, "agents", composer(creating, { id: "early", name: "Early" }));
  insert(db, "agents", composer(ws.a));
  insert(db, "agents", cli(ws.a, { id: "c0", name: "Old", archived: 1, archived_at: "before" }));
  insert(db, "agents", cli(ws.b));
  const finalised = workspace(journal, "p1");
  insert(db, "agents", cli(finalised, { id: "fin", name: "Finisher" }));
  journal.transitionWorkspace(finalised, "FINALISED", { outcome: "merged" });
  assert.equal(agent(db, "fin")["archived"], 1, "a finalised home is not live: its agents are archived");
  assert.throws(() => insert(db, "agents", composer(finalised, { id: "f", name: "F" })), /being created or ready/);
  assert.throws(() => db.prepare("UPDATE agents SET archived = 0, archived_at = NULL WHERE id = 'fin'").run(), /not live stays archived/);
  journal.transitionWorkspace(ws.a, "REMOVING");
  const gone = journal.getWorkspace(ws.a)!;
  assert.deepEqual([agent(db, "a1")["archived"], agent(db, "a1")["archived_at"], agent(db, "a1")["updated_at"]], [1, gone.updatedAt, gone.updatedAt]);
  assert.equal(agent(db, "c0")["archived_at"], "before", "an archived agent is left as it was");
  assert.equal(agent(db, "c1")["archived"], 0, "another workspace's agent stays live");
  assert.throws(() => insert(db, "agents", composer(ws.a, { id: "late", name: "Late" })), /being created or ready/);
  assert.throws(() => db.prepare("UPDATE agents SET archived = 0, archived_at = NULL WHERE id = 'a1'").run(), /not live stays archived/);
  journal.transitionWorkspace(ws.a, "REMOVED");
  assert.throws(() => db.prepare("UPDATE agents SET archived = 0, archived_at = NULL WHERE id = 'a1'").run(), /not live stays archived/);
  journal.transitionWorkspace(creating, "FAILED");
  assert.equal(agent(db, "early")["archived"], 1, "a workspace that failed to create archives its agents");
  // A removal that was abandoned returns the workspace to READY: its agents stay archived until the user restores them.
  journal.transitionWorkspace(ws.b, "REMOVING");
  journal.transitionWorkspace(ws.b, "READY");
  assert.equal(agent(db, "c1")["archived"], 1);
  db.prepare("UPDATE agents SET archived = 0, archived_at = NULL WHERE id = 'c1'").run();
  assert.equal(agent(db, "c1")["archived"], 0);
  db.close();
});

test("an id is inserted once: INSERT OR REPLACE cannot rewrite an agent, a group, a run or a workspace", () => {
  const { db, journal, ws } = setup();
  insert(db, "agent_groups", group());
  insert(db, "agent_groups", group({ id: "g2", project_id: "p2" }));
  insert(db, "agents", cli(ws.a));
  const run = journal.createRun({ workspaceId: ws.a, kind: "cli", createdBy: "user" }).value.id;
  db.prepare("INSERT INTO agent_runs (id, workspace_id, kind, state, created_at, updated_at, agent_id) VALUES ('r-k', ?, 'cli', 'QUEUED', ?, ?, 'c1')").run(ws.a, T, T);
  const moved = composer(ws.other, { id: "c1", project_id: "p2", group_id: "g2", created_at: "later" });
  for (const verb of ["INSERT OR REPLACE", "REPLACE"]) {
    const cols = Object.keys(moved);
    assert.throws(() => db.prepare(`${verb} INTO agents (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...Object.values(moved)), /an agent is inserted once/, verb);
    assert.throws(() => db.prepare(`${verb} INTO agent_groups (id, project_id, name, ord, created_by, created_at, updated_at) VALUES ('g1', 'p2', 'X', 0, 'user', 'later', 'later')`).run(), /a group is inserted once/, verb);
    for (const id of [run, "r-k"]) {
      assert.throws(() => db.prepare(`${verb} INTO agent_runs (id, workspace_id, kind, state, created_at, updated_at) VALUES (?, ?, 'cli', 'QUEUED', ?, ?)`).run(id, ws.a, T, T), /a run is inserted once/, verb);
    }
    assert.throws(() => db.prepare(`${verb} INTO agent_workspaces (id, project_id, branch, base_ref, base_sha, created_by, state, created_at, updated_at) VALUES (?, 'p1', 'axis/x', 'HEAD', ?, 'user', 'REMOVED', ?, ?)`).run(ws.a, "c".repeat(40), T, T), /a workspace is inserted once/, verb);
  }
  // The guard fires before any conflict clause, with the trigger's error code (1811), not a UNIQUE one.
  for (const sql of ["INSERT OR IGNORE INTO agent_groups (id, project_id, name, ord, created_by, created_at, updated_at) VALUES ('g1', 'p1', 'X', 0, 'user', 't', 't')",
    "INSERT INTO agent_groups (id, project_id, name, ord, created_by, created_at, updated_at) VALUES ('g1', 'p1', 'X', 0, 'user', 't', 't') ON CONFLICT DO NOTHING",
    "INSERT INTO agent_groups (id, project_id, name, ord, created_by, created_at, updated_at) VALUES ('g1', 'p1', 'X', 0, 'user', 't', 't') ON CONFLICT (id) DO UPDATE SET name = 'Y'"]) {
    assert.throws(() => db.prepare(sql).run(), (e: unknown) => (e as { errcode?: number }).errcode === 1811 && /inserted once/.test(String(e)), sql);
  }
  assert.deepEqual([agent(db, "c1")["project_id"], agent(db, "c1")["kind"], agent(db, "c1")["archived"]], ["p1", "cli", 0]);
  assert.equal((db.prepare("SELECT agent_id FROM agent_runs WHERE id = 'r-k'").get() as { agent_id: string }).agent_id, "c1");
  db.close();
});
