// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { HandlerContext } from "@axis/daemon";
import { untrusted } from "../../src/gate/project-trust.js";
import { startComposerRun, type ComposerRunsHandlerDeps } from "../../src/handlers/composer-runs.js";

// The one composer start path (PV-G4 slice B): the worker reaches the service as the run's agent; under the mutex the recheck
// runs first and the project trust gate last, right before the start, with its ticket handed to the service to spend.

function rig(admit: (scope: unknown) => Promise<unknown> = async () => "ticket-1") {
  const order: string[] = [];
  const started: Array<[unknown, unknown]> = [];
  const deps = {
    journal: { getWorkspace: (id: string) => (id === "ws-1" ? { projectId: "p1" } : undefined) },
    gate: { admit: async (scope: unknown) => (order.push("gate"), admit(scope)) },
    mutex: { run: async (_k: string, fn: () => Promise<unknown>) => (order.push("mutex"), fn()) },
    service: { start: async (input: unknown, _s: AbortSignal, ticket: unknown) => (started.push([input, ticket]), order.push("start"), { run: { runId: "r1" }, replayed: false }) },
  } as unknown as ComposerRunsHandlerDeps;
  return { deps, order, started };
}
const ctx = { identity: { actor: "user", connectionId: "c".repeat(22), windowId: "win-1", actorId: "a", trusted: true, clientKind: "desktop" }, requestId: "q", correlationId: "k", signal: new AbortController().signal, idempotencyKey: "k-1" } as unknown as HandlerContext;
const REQ = { workspaceId: "ws-1", mode: "agent" as const, prompt: "p", providerId: "mock", modelId: "m" };

test("the worker and the gate's ticket reach the service; a start without a worker passes none", async () => {
  const { deps, started } = rig(async () => "ticket-9");
  await startComposerRun(deps, { ...REQ, worker: "w1" }, ctx);
  await startComposerRun(deps, REQ, ctx);
  assert.deepEqual(started.map(([i, t]) => [(i as { worker?: string }).worker, t, (i as { windowId: string }).windowId]), [["w1", "ticket-9", "win-1"], [undefined, "ticket-9", "win-1"]]);
  assert.equal("worker" in (started[1]![0] as object), false);
});

test("under the mutex: the recheck first, the gate last, then the start; a refusing recheck or gate starts nothing", async () => {
  const { deps, order } = rig();
  const seen: string[] = [];
  await startComposerRun(deps, { ...REQ, worker: "w1", recheck: () => void seen.push(order.join(",")) }, ctx);
  assert.deepEqual([seen, order], [["mutex"], ["mutex", "gate", "start"]]);
  const archived = rig();
  await assert.rejects(startComposerRun(archived.deps, { ...REQ, worker: "w1", recheck: () => { throw new Error("archived"); } }, ctx), /archived/);
  assert.deepEqual([archived.order, archived.started], [["mutex"], []]);
  const scopes: unknown[] = [];
  const no = rig(async (scope) => (scopes.push(scope), Promise.reject(untrusted())));
  await assert.rejects(startComposerRun(no.deps, { ...REQ, worker: "w1" }, ctx));
  assert.deepEqual(no.started, [], "a worker start the gate refuses starts nothing");
  assert.deepEqual(scopes.map((s) => ({ ...(s as object), signal: undefined })), [{ projectId: "p1", windowId: "win-1", workspaceId: "ws-1", signal: undefined }]);
});

test("the run takes the launch the recheck read fresh under the mutex, not the one read before the wait", async () => {
  const { deps, started } = rig();
  await startComposerRun(deps, { ...REQ, worker: "w1", recheck: () => ({ mode: "ask", modelId: "m2", providerId: "other" }) }, ctx);
  const input = started[0]![0] as { mode: string; modelId: string; providerId: string; prompt: string; workspaceId: string };
  assert.deepEqual([input.mode, input.modelId, input.providerId, input.prompt, input.workspaceId], ["ask", "m2", "other", "p", "ws-1"]);
  const plain = rig();
  await startComposerRun(plain.deps, { ...REQ, recheck: () => undefined }, ctx);
  assert.deepEqual([(plain.started[0]![0] as { mode: string }).mode, (plain.started[0]![0] as { modelId: string }).modelId], ["agent", "m"], "no fresh launch: the request's");
});
