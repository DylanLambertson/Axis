// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { providerForConnection } from "../../src/agents/start.js";
import { composerRig, START, until } from "../composer-rig.js";

// PV-G4 slice B: the real composer service records the worker a run is started for, and a connection resolves to the
// provider serving it (none: undefined, so the start is connection_unavailable).

test("the composer service records the worker on the run; a start without one records none", async (t) => {
  const c = await composerRig({ replies: [{ kind: "text", text: "done" }, { kind: "text", text: "done" }] });
  t.after(() => c.cleanup());
  const ws = c.journal.getWorkspace(c.workspaceId)!;
  if (c.journal.getProject(ws.projectId) === undefined) c.journal.registerProject({ id: ws.projectId, path: "/repo/composer-worker", displayName: "p", trusted: false, actor: "user" });
  c.journal.agents.create({ id: "w1", projectId: ws.projectId, name: "Planner", launch: { kind: "composer", connection: "mock", modelId: "mock-model", mode: "edit" }, homeWorkspaceId: c.workspaceId, groupId: null });
  const agentOf = (runId: string): unknown => (c.journal.agents.agentOfRun(runId) ?? null);
  const { run } = await c.service.start({ ...START(c.workspaceId), worker: "w1" } as never, new AbortController().signal);
  assert.equal(agentOf(run.runId), "w1");
});

test("a connection resolves to the provider serving it, and only that one", () => {
  const providers = [{ descriptor: { connectionId: "anthropic-main", providerId: "anthropic" } }, { descriptor: { connectionId: "mock", providerId: "mock" } }];
  assert.equal(providerForConnection(providers, "mock"), "mock");
  assert.equal(providerForConnection(providers, "anthropic-main"), "anthropic");
  assert.equal(providerForConnection(providers, "gone"), undefined);
  assert.equal(providerForConnection([], "mock"), undefined);
});

test("through the real composer service: the same idempotency key replays the first run and starts no second one", async (t) => {
  const c = await composerRig({ replies: [{ kind: "text", text: "done" }, { kind: "text", text: "done" }] });
  t.after(() => c.cleanup());
  const key = "11111111-1111-4111-8111-111111111111";
  const first = await c.service.start({ ...START(c.workspaceId), idempotencyKey: key } as never, new AbortController().signal);
  // The service answers a live run's workspace `active_run` before the journal's replay: wait until the first run has ended.
  await until(() => !c.service.get(first.run.runId).live);
  const again = await c.service.start({ ...START(c.workspaceId), idempotencyKey: key } as never, new AbortController().signal);
  assert.equal(again.replayed, true);
  assert.equal(again.run.runId, first.run.runId);
  assert.equal(c.journal.listRuns({ workspaceId: c.workspaceId }).filter((r) => r.kind === "composer").length, 1);
});
