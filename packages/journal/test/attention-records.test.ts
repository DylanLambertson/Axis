// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AuditLog, openDatabase } from "@axis/audit";
import { Journal, MAX_ATTENTION_ROWS } from "../src/index.js";

// The journal reads behind `axis.attention/1` (ticket PV-D4): the newest run of each live workspace, the running runs, and
// the user's unread messages, each for one project and bounded by its limit. Every case has a refusing neighbour: another
// project, a workspace that is no longer live, a run that is not the newest, a message already read or not to the user.

const T = "2026-11-22T00:00:00.000Z";
const USER = "user" as const;

function setup() {
  const db = openDatabase(":memory:");
  const journal = Journal.open(db, { audit: new AuditLog(db) });
  for (const id of ["p1", "p2"]) journal.registerProject({ id, path: `/repo/${id}`, displayName: id, trusted: false, actor: "user" });
  let n = 0;
  const ws = (projectId: string, ready = true): string => {
    const id = journal.createWorkspace({ projectId, branch: `axis/w${n++}`, baseRef: "HEAD", baseSha: "c".repeat(40), createdBy: "user" }).value.id;
    if (ready) journal.transitionWorkspace(id, "READY");
    return id;
  };
  const run = (workspaceId: string, kind: "cli" | "composer", path: readonly string[] = []): string => {
    const id = journal.createRun({ workspaceId, kind, createdBy: "user" }).value.id;
    for (const s of path) journal.transitionRun(id, s as "RUNNING", { actor: USER });
    return id;
  };
  return { db, journal, ws, run, attention: journal.attention };
}

test("latestRuns: the newest run of each live workspace of the project, with its kind, state and agent", () => {
  const { journal, ws, run, attention, db } = setup();
  const [a, b, empty, other] = [ws("p1"), ws("p1"), ws("p1"), ws("p2")];
  run(a, "cli", ["RUNNING", "FAILED"]);
  const newestA = run(a, "composer", ["RUNNING"]);
  const newestB = run(b, "cli", ["RUNNING", "CANCELLED"]);
  run(other, "cli", ["RUNNING", "FAILED"]);
  const queued = ws("p1");
  const queuedRun = run(queued, "cli");
  ws("p1", false); // still being created: no run, no row
  // Workspaces that are no longer live: finalised, being removed, removed.
  const gone = [ws("p1"), ws("p1"), ws("p1")];
  for (const g of gone) run(g, "cli", ["RUNNING", "FAILED"]);
  journal.transitionWorkspace(gone[0] as string, "FINALISED", { actor: USER, outcome: "abandoned" });
  for (const g of gone.slice(1)) journal.transitionWorkspace(g, "REMOVING", { actor: USER, reason: "USER_REMOVED" });
  journal.transitionWorkspace(gone[2] as string, "REMOVED");

  const got = attention.latestRuns("p1", 100);
  const want = [
    { runId: newestA, workspaceId: a, kind: "composer", state: "RUNNING", agentId: null },
    { runId: newestB, workspaceId: b, kind: "cli", state: "CANCELLED", agentId: null },
    { runId: queuedRun, workspaceId: queued, kind: "cli", state: "QUEUED", agentId: null },
  ].sort((x, y) => (x.workspaceId < y.workspaceId ? -1 : 1));
  assert.deepEqual(got, want, "one row per live workspace, ordered by workspace id; a workspace with no run has none");
  assert.equal(got.some((r) => r.workspaceId === empty), false);
  assert.deepEqual(attention.latestRuns("p2", 100).map((r) => r.state), ["FAILED"]);
  assert.deepEqual(attention.latestRuns("nope", 100), []);
  assert.equal(attention.latestRuns("p1", 2).length, 2, "the limit bounds the rows");

  // The agent a run was started for comes back (written as PV-G4 will: at insert, in the agent's home workspace).
  journal.agents.create({ id: "ag1", projectId: "p1", name: "Builder", launch: { kind: "cli", entryId: "my-cli" }, homeWorkspaceId: b, groupId: null });
  db.prepare("INSERT INTO agent_runs (id, workspace_id, kind, state, created_at, updated_at, agent_id) VALUES ('r-agent', ?, 'cli', 'QUEUED', ?, ?, 'ag1')").run(b, "9999-01-01T00:00:00.000Z", T);
  assert.equal(attention.latestRuns("p1", 100).find((r) => r.workspaceId === b)?.agentId, "ag1");
  assert.equal(attention.latestRuns("p1", 100).find((r) => r.workspaceId === b)?.runId, "r-agent", "newest by created_at");
});

test("latestRuns: runs created in the same instant are told apart by insertion order", () => {
  const db = openDatabase(":memory:");
  const journal = Journal.open(db, { audit: new AuditLog(db), now: () => new Date(T) });
  journal.registerProject({ id: "p1", path: "/repo/p1", displayName: "p1", trusted: false, actor: "user" });
  const w = journal.createWorkspace({ projectId: "p1", branch: "axis/x", baseRef: "HEAD", baseSha: "c".repeat(40), createdBy: "user" }).value.id;
  journal.transitionWorkspace(w, "READY");
  const ids = [0, 1, 2].map(() => journal.createRun({ workspaceId: w, kind: "cli", createdBy: "user" }).value.id);
  assert.equal(journal.attention.latestRuns("p1", 10)[0]?.runId, ids[2]);
});

test("runningRuns: RUNNING runs of the project's live workspaces only, oldest first", () => {
  const { db, ws, run, attention } = setup();
  const [a, b, other] = [ws("p1"), ws("p1"), ws("p2")];
  const r1 = run(a, "composer", ["RUNNING"]);
  run(a, "cli");
  run(a, "cli", ["RUNNING", "FAILED"]);
  run(a, "cli", ["RUNNING", "BLOCKED"]);
  const r2 = run(b, "cli", ["RUNNING"]);
  run(other, "cli", ["RUNNING"]);
  const finalised = ws("p1");
  run(finalised, "cli", ["RUNNING"]);
  // A run the journal still holds as RUNNING in a workspace that is no longer live (recovery's business, not attention's).
  db.prepare("UPDATE agent_workspaces SET state = 'FINALISED', finalise_outcome = 'abandoned' WHERE id = ?").run(finalised);
  assert.deepEqual(attention.runningRuns("p1", 100).map((r) => [r.runId, r.kind, r.state]), [[r1, "composer", "RUNNING"], [r2, "cli", "RUNNING"]]);
  assert.deepEqual(attention.runningRuns("p1", 1).map((r) => r.runId), [r1]);
  assert.deepEqual(attention.runningRuns("nope", 100), []);
});

function thread(db: ReturnType<typeof setup>["db"], id: string, projectId: string): void {
  db.prepare("INSERT INTO message_threads (id, project_id, created_at, last_at) VALUES (?, ?, ?, ?)").run(id, projectId, T, T);
}
function message(db: ReturnType<typeof setup>["db"], threadId: string, seq: number, to: string): void {
  const id = `msg_${threadId.slice(4, 21)}${String(seq).padStart(5, "0")}`;
  db.prepare("INSERT INTO agent_messages (id, thread_id, seq, sender, sender_key, recipients, expanded, body, refs, hop, created_at) VALUES (?, ?, ?, '{}', 'agent:a1', '[]', '[]', 'secret body', '[]', 0, ?)").run(id, threadId, seq, T);
  db.prepare("INSERT INTO message_recipients (principal, message_id, thread_id, seq, sender_key, counted) VALUES (?, ?, ?, ?, 'agent:a1', 0)").run(to, id, threadId, seq);
}

test("unreadForUser: messages to the user past the user's cursor in the project's threads, up to the limit", () => {
  const { db, attention, journal } = setup();
  const [t1, t2, t3] = ["thr_aaaaaaaaaaaaaaaaaaaaaa", "thr_bbbbbbbbbbbbbbbbbbbbbb", "thr_cccccccccccccccccccccc"];
  thread(db, t1, "p1");
  thread(db, t2, "p1");
  thread(db, t3, "p2");
  for (const seq of [1, 2, 3]) message(db, t1, seq, "user");
  message(db, t2, 1, "agent:a2");
  message(db, t2, 2, "user");
  message(db, t3, 1, "user");
  assert.equal(attention.unreadForUser("p1", 100), 4, "every thread of the project; another principal's message is not counted");
  journal.messages.markRead(t1, "user", 2);
  assert.equal(attention.unreadForUser("p1", 100), 2, "the cursor hides what the user read");
  journal.messages.markRead(t2, "agent:a2", 2);
  assert.equal(attention.unreadForUser("p1", 100), 2, "another principal's cursor does not");
  assert.equal(attention.unreadForUser("p1", 1), 1, "counted up to the limit");
  assert.equal(attention.unreadForUser("p2", 100), 1);
  assert.equal(attention.unreadForUser("nope", 100), 0);
});

test("every read refuses a limit outside 1 to MAX_ATTENTION_ROWS", () => {
  const { attention } = setup();
  for (const bad of [0, -1, 1.5, MAX_ATTENTION_ROWS + 1, Number.NaN]) {
    assert.throws(() => attention.latestRuns("p1", bad), /limit/, String(bad));
    assert.throws(() => attention.runningRuns("p1", bad), /limit/, String(bad));
    assert.throws(() => attention.unreadForUser("p1", bad), /limit/, String(bad));
  }
  assert.deepEqual(attention.latestRuns("p1", MAX_ATTENTION_ROWS), []);
  assert.deepEqual(attention.runningRuns("p1", 1), []);
});
