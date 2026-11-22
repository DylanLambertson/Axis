// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { attestedWindow } from "../../testing/attested.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { HandlerContext } from "@axis/daemon";
import { untrusted } from "../../src/gate/project-trust.js";
import { startCliRun, type CliRunsHandlerDeps } from "../../src/handlers/cli-runs.js";

// The one CLI start path (PV-G4): the worker reaches the supervisor as the run's agent; the recheck runs under the mutex
// after the workspace is read again and before the project trust gate; the gate's ticket is what the minter spends.

function rig(admit: (scope: unknown) => Promise<unknown> = async () => "ticket-1") {
  const order: string[] = [];
  const started: unknown[] = [];
  const minted: unknown[] = [];
  const deps: CliRunsHandlerDeps = {
    journal: { getWorkspace: (id: string) => (id === "ws-1" ? ({ id, projectId: "p1", state: "READY" } as never) : undefined) },
    control: { settingsGet: async () => [{ id: "fake", label: "Fake CLI", command: [process.execPath], args: [] }] } as never,
    gate: { admit: async (scope: unknown) => (order.push("gate"), admit(scope)) } as never,
    minter: { attest: (facts, ticket) => (order.push("attest"), minted.push([facts, ticket]), { token: "t" }) as never },
    mutex: { run: async (_k: string, fn: () => Promise<unknown>) => (order.push("mutex"), fn()) } as never,
    service: { start: async (req: unknown) => (started.push(req), order.push("start"), { run: { runId: "r1" } as never, replayed: false }) } as never,
    platform: "linux",
  };
  return { deps, order, started, minted };
}
const ctx = { identity: attestedWindow("win-1", { connectionId: "c".repeat(22), actorId: "a" }), requestId: "q", correlationId: "k", signal: new AbortController().signal, idempotencyKey: "k-1" } as unknown as HandlerContext;

test("the worker is passed to the supervisor; a start without one passes none", async () => {
  const { deps, started } = rig();
  await startCliRun(deps, { workspaceId: "ws-1", entryId: "fake", worker: "w1" }, ctx);
  await startCliRun(deps, { workspaceId: "ws-1", entryId: "fake" }, ctx);
  assert.equal((started[0] as { worker?: string }).worker, "w1");
  assert.equal("worker" in (started[1] as object), false);
});

test("the recheck runs under the mutex before the gate; a refusing recheck starts nothing", async () => {
  const { deps, order } = rig();
  const seen: string[] = [];
  await startCliRun(deps, { workspaceId: "ws-1", entryId: "fake", recheck: () => void seen.push([...order].join(",")) }, ctx);
  assert.deepEqual(seen, ["mutex"], "after the mutex is taken, before the gate");
  const refused = rig();
  await assert.rejects(startCliRun(refused.deps, { workspaceId: "ws-1", entryId: "fake", recheck: () => { throw new Error("archived"); } }, ctx), /archived/);
  assert.deepEqual([refused.order, refused.started], [["mutex"], []]);
});

test("the gate decides for a worker start too: its scope is the run's workspace and project, its ticket is what is spent", async () => {
  const scopes: unknown[] = [];
  const ok = rig(async (scope) => (scopes.push(scope), "ticket-7"));
  await startCliRun(ok.deps, { workspaceId: "ws-1", entryId: "fake", worker: "w1" }, ctx);
  assert.deepEqual(scopes.map((s) => ({ ...(s as object), signal: undefined })), [{ projectId: "p1", caller: { windowId: "win-1" }, workspaceId: "ws-1", signal: undefined }]);
  assert.deepEqual(ok.minted, [[{ workspaceId: "ws-1", projectId: "p1" }, "ticket-7"]]);
  const no = rig(async () => Promise.reject(untrusted()));
  await assert.rejects(startCliRun(no.deps, { workspaceId: "ws-1", entryId: "fake", worker: "w1" }, ctx), (e: unknown) => (e as { detail?: { reason?: string } }).detail?.reason === "untrusted");
  assert.deepEqual([no.order.includes("attest"), no.started.length], [false, 0], "a refused worker start mints nothing and starts nothing");
});
