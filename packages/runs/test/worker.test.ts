// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { harness } from "./helpers.js";

// PV-G4: a CLI run started for an Axis agent records it as the run's `agent_id`, in the journal's own insert; the v12
// trigger refuses an archived agent or one homed elsewhere before any process starts.

function withAgent(h: ReturnType<typeof harness>) {
  const w = h.workspace();
  h.journal.registerProject({ id: w.projectId, path: `/repo/${w.projectId}`, displayName: "p", trusted: false, actor: "user" });
  h.journal.agents.create({ id: "w1", projectId: w.projectId, name: "Worker", launch: { kind: "cli", entryId: "fake" }, homeWorkspaceId: w.id, groupId: null });
  return w;
}
const agentOf = (h: ReturnType<typeof harness>, runId: string): unknown =>
  (h.db.prepare("SELECT agent_id FROM agent_runs WHERE id = ?").get(runId) as { agent_id: unknown }).agent_id;

test("a start with a worker records it on the run; a start without one records none", async () => {
  const h = harness();
  const w = withAgent(h);
  const started = await h.supervisor.start({ workspaceId: w.id, agent: { id: "fake", label: "Fake CLI", command: ["fakecli"], args: [] }, actor: "user", trust: h.attest(w), worker: "w1" });
  assert.equal(agentOf(h, started.run.runId), "w1");
  const other = h.workspace();
  const plain = await h.start(other);
  assert.equal(agentOf(h, plain.run.runId), null);
});

test("a malformed worker id is refused before anything starts; an archived worker's start is refused by the journal", async () => {
  const h = harness();
  const w = withAgent(h);
  const base = { workspaceId: w.id, agent: { id: "fake", label: "Fake CLI", command: ["fakecli"], args: [] }, actor: "user" as const };
  for (const worker of ["", "-w", "a b", "x".repeat(65)]) {
    await assert.rejects(h.supervisor.start({ ...base, trust: h.attest(w), worker }), (e: unknown) => (e as { code?: string }).code === "E_INVALID_ARGUMENT", JSON.stringify(worker));
  }
  assert.equal(h.pty.handles.length, 0);
  h.journal.agents.archive("w1");
  await assert.rejects(h.supervisor.start({ ...base, trust: h.attest(w), worker: "w1" }));
  assert.equal(h.pty.handles.length, 0, "no process for an archived worker");
  assert.equal(h.db.prepare("SELECT count(*) AS n FROM agent_runs").get()?.["n"], 0);
});
