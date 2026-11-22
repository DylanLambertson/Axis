// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AuditLog, AxisError, openDatabase } from "@axis/audit";
import { DaemonError, type HandlerContext, type Identity } from "@axis/daemon";
import { Journal } from "@axis/journal";
import { createAgentStart } from "../../src/agents/start.js";
import { createAgentsService } from "../../src/agents/service.js";
import { createAgentsHandlers } from "../../src/handlers/agents.js";
import type { CliStart } from "../../src/handlers/cli-runs.js";
import type { ComposerStart } from "../../src/handlers/composer-runs.js";
import { hostMessagingDeps } from "../../src/messages/binding.js";
import { InMemoryTrustRegistry } from "../../src/policy/trust-registry.js";
import { runFailure, toRunError } from "../../src/runs/errors.js";
import { ProjectMutex } from "../../src/worktrees/project-mutex.js";

// axis.agents/1.start (PV-G4 slice A): resolved from the journal (live agent, READY home of its project, its launch), the CLI
// path recorded with the agent; composer agents are slice B; the run errors fold into the contract's closed reasons; and
// the messaging option keeps a worker run outside messaging unless it is enabled.

function setup(startCli?: (req: CliStart) => Promise<unknown>, opts: { startComposer?: (req: ComposerStart) => Promise<unknown>; providers?: Record<string, string> } = {}) {
  const providers: Record<string, string> = opts.providers ?? { c: "mock" };
  const db = openDatabase(":memory:");
  const journal = Journal.open(db, { audit: new AuditLog(db) });
  journal.registerProject({ id: "p1", path: "/repo/p1", displayName: "p1", trusted: false, actor: "user" });
  const home = journal.createWorkspace({ projectId: "p1", branch: "axis/home", baseRef: "HEAD", baseSha: "c".repeat(40), createdBy: "user" }).value.id;
  journal.transitionWorkspace(home, "READY");
  journal.agents.create({ id: "cli1", projectId: "p1", name: "Shell", launch: { kind: "cli", entryId: "my-cli" }, homeWorkspaceId: home, groupId: null });
  journal.agents.create({ id: "cmp1", projectId: "p1", name: "Planner", launch: { kind: "composer", connection: "c", modelId: "m", mode: "agent" }, homeWorkspaceId: home, groupId: null });
  const calls: CliStart[] = [];
  const cli = async (req: CliStart) => {
    calls.push(req);
    if (startCli !== undefined) return startCli(req);
    req.recheck?.();
    const run = journal.createRun({ workspaceId: req.workspaceId, kind: "cli", createdBy: "user", ...(req.worker === undefined ? {} : { agentId: req.worker }) }).value;
    return { run: { runId: run.id }, replayed: false };
  };
  const composerCalls: ComposerStart[] = [];
  const composer = async (req: ComposerStart) => {
    composerCalls.push(req);
    if (opts.startComposer !== undefined) return opts.startComposer(req);
    req.recheck?.();
    const run = journal.createRun({ workspaceId: req.workspaceId, kind: "composer", createdBy: "user", ...(req.worker === undefined ? {} : { agentId: req.worker }) }).value;
    return { run: { runId: run.id }, replayed: false };
  };
  const service = createAgentsService({ journal, worktrees: { create: async () => ({ id: "x" }) as never }, mutex: new ProjectMutex(), trust: new InMemoryTrustRegistry(), newId: () => "n1" });
  const h = createAgentsHandlers(service, createAgentStart({ journal, startCli: cli as never, startComposer: composer as never, providerFor: (c: string) => providers[c] }));
  return { db, journal, home, calls, composerCalls, providers, start: h.agents.start };
}
const identity: Identity = { connectionId: "c1", windowId: "win-1", actorId: "u", actor: "user", trusted: true, clientKind: "desktop" };
const call = (h: (c: HandlerContext, p: never) => unknown, payload: unknown): Promise<unknown> =>
  Promise.resolve(h({ identity, signal: new AbortController().signal, requestId: "r", correlationId: "c" } as unknown as HandlerContext, payload as never));
async function refused(p: Promise<unknown>, code: string, reason?: string): Promise<void> {
  await assert.rejects(p, (e: unknown) => e instanceof DaemonError && e.code === code && (reason === undefined ? e.details === undefined : e.details?.["reason"] === reason));
}

test("a CLI agent's start runs in its home with its entry and records the agent; the caller names nothing else", async () => {
  const { start, calls, home, db } = setup();
  const out = (await call(start, { agentId: "cli1" })) as { runId: string; kind: string; workspaceId: string; replayed: boolean };
  assert.deepEqual([out.kind, out.workspaceId, out.replayed], ["cli", home, false]);
  assert.deepEqual(calls.map((c) => [c.workspaceId, c.entryId, c.worker]), [[home, "my-cli", "cli1"]]);
  assert.equal((db.prepare("SELECT agent_id FROM agent_runs WHERE id = ?").get(out.runId) as { agent_id: string }).agent_id, "cli1");
});

test("refused: an unknown or archived agent, a home that is not READY, a prompt for a CLI agent, a composer agent without one", async () => {
  const { start, journal, home, calls } = setup();
  await refused(call(start, { agentId: "nope" }), "E_NOT_FOUND", "not_found");
  await refused(call(start, { agentId: "cli1", input: { prompt: "hi" } }), "E_INVALID_ARGUMENT");
  await refused(call(start, { agentId: "cmp1" }), "E_INVALID_ARGUMENT");
  journal.agents.archive("cli1");
  await refused(call(start, { agentId: "cli1" }), "E_CONFLICT", "archived");
  journal.agents.restore("cli1");
  journal.transitionWorkspace(home, "FINALISED", { outcome: "merged" });
  await refused(call(start, { agentId: "cli1" }), "E_CONFLICT", "archived"); // the home leaving READY archived it
  assert.deepEqual(calls, [], "the CLI path was never reached");
});

test("the agent is checked again under the mutex: archived while the start waited, it is refused", async () => {
  const { start, journal } = setup(async (req) => {
    journal.agents.archive("cli1");
    req.recheck?.();
    throw new Error("not reached");
  });
  await refused(call(start, { agentId: "cli1" }), "E_CONFLICT", "archived");
});

test("run refusals fold into the contract's closed reasons; anything else is E_INTERNAL; cancellation stays", async () => {
  const cases: Array<[DaemonError | Error, string, string | undefined]> = [
    [runFailure("E_CONFLICT", "untrusted"), "E_CONFLICT", "untrusted_project"],
    [runFailure("E_CONFLICT", "attestation_used"), "E_CONFLICT", "untrusted_project"],
    [runFailure("E_NOT_FOUND", "agent_unknown"), "E_CONFLICT", "entry_unavailable"],
    [runFailure("E_CONFLICT", "executable_not_found"), "E_CONFLICT", "entry_unavailable"],
    [runFailure("E_CONFLICT", "active_run"), "E_CONFLICT", "busy"],
    // The real shape of the run limit: the supervisor's refusal as `toRunError` turns it (E_BACKPRESSURE, no reason).
    [toRunError(new AxisError("E_BACKPRESSURE", "Too many CLI runs are active on this device", { reason: "RUN_LIMIT" })), "E_CONFLICT", "busy"],
    [runFailure("E_CONFLICT", "not_ready"), "E_CONFLICT", "home_unavailable"],
    [runFailure("E_UNAVAILABLE", "needs_attention"), "E_CONFLICT", "home_unavailable"],
    [runFailure("E_NOT_FOUND"), "E_CONFLICT", "home_unavailable"],
    [runFailure("E_UNAVAILABLE", "settings_unavailable"), "E_UNAVAILABLE", "not_available"],
    [runFailure("E_UNAVAILABLE", "snapshot_timeout"), "E_UNAVAILABLE", "not_available"],
    [runFailure("E_CANCELLED"), "E_CANCELLED", undefined],
    [new Error("/secret/path"), "E_INTERNAL", undefined],
  ];
  for (const [thrown, code, reason] of cases) {
    const { start } = setup(async () => Promise.reject(thrown));
    await assert.rejects(call(start, { agentId: "cli1" }), (e: unknown) => {
      assert.ok(e instanceof DaemonError, String(thrown));
      assert.equal(e.code, code, String(thrown.message));
      assert.equal(e.details?.["reason"], reason, String(thrown.message));
      return true;
    });
  }
});

test("messaging.enabled: off (the default), a worker run is outside messaging; on, its recorded agent counts", async () => {
  const { start, journal } = setup();
  const out = (await call(start, { agentId: "cli1" })) as { runId: string };
  const deps = (enabled?: boolean) =>
    hostMessagingDeps({ journal, audit: { append: () => undefined }, monotonic: () => 0, scan: async () => [], holdsSecret: () => false, logger: undefined, ...(enabled === undefined ? {} : { enabled }) });
  assert.equal(deps().agentOf?.(out.runId), undefined, "default: no tools, no delivery");
  assert.equal(deps(false).agentOf?.(out.runId), undefined);
  assert.equal(deps(true).agentOf?.(out.runId), "cli1");
});

test("a live agent whose home is not READY (still being created) is home_unavailable, and the CLI path is not reached", async () => {
  const { start, journal, db, calls } = setup();
  const creating = journal.createWorkspace({ projectId: "p1", branch: "axis/new", baseRef: "HEAD", baseSha: "c".repeat(40), createdBy: "user" }).value.id;
  db.prepare("INSERT INTO agents (id, project_id, name, kind, cli_entry_id, home_workspace_id, created_by, created_at, updated_at) VALUES ('early', 'p1', 'Early', 'cli', 'e', ?, 'user', 't', 't')").run(creating);
  await refused(call(start, { agentId: "early" }), "E_CONFLICT", "home_unavailable");
  assert.deepEqual(calls, []);
});

test("through the real CLI start path: a worker start passes the project trust gate; a refused gate is untrusted_project, no process, no run", async () => {
  const { untrusted } = await import("../../src/gate/project-trust.js");
  const { startCliRun } = await import("../../src/handlers/cli-runs.js");
  for (const trusted of [true, false]) {
    const gated: unknown[] = [];
    const processes: unknown[] = [];
    let journalRef: Journal | undefined;
    const { start, journal, db, home } = setup(async (req) => {
      const deps = {
        journal: journalRef!,
        control: { settingsGet: async () => [{ id: "my-cli", label: "CLI", command: [process.execPath], args: [] }] },
        gate: { admit: async (scope: unknown) => (gated.push(scope), trusted ? "ticket" : Promise.reject(untrusted())) },
        minter: { attest: () => ({ token: "t" }) },
        mutex: { run: async (_k: string, fn: () => Promise<unknown>) => fn() },
        service: {
          start: async (r: { workspaceId: string; worker?: string }) => {
            processes.push(r);
            const run = journalRef!.createRun({ workspaceId: r.workspaceId, kind: "cli", createdBy: "user", ...(r.worker === undefined ? {} : { agentId: r.worker }) }).value;
            return { run: { runId: run.id }, replayed: false };
          },
        },
        platform: "linux" as const,
      };
      return startCliRun(deps as never, req, { identity, signal: new AbortController().signal, requestId: "r", correlationId: "c" } as unknown as HandlerContext);
    });
    journalRef = journal;
    const runs = () => (db.prepare("SELECT agent_id FROM agent_runs").all() as Array<{ agent_id: string }>).map((r) => r.agent_id);
    if (trusted) {
      const out = (await call(start, { agentId: "cli1" })) as { workspaceId: string };
      assert.equal(out.workspaceId, home);
      assert.deepEqual(runs(), ["cli1"]);
    } else {
      await refused(call(start, { agentId: "cli1" }), "E_CONFLICT", "untrusted_project");
      assert.deepEqual([processes, runs()], [[], []], "no process, no run row");
    }
    assert.equal((gated[0] as { workspaceId: string }).workspaceId, home, "the gate was asked for the worker's home");
  }
});

test("a composer agent's start runs in its home with its mode, model and the provider serving its connection, recorded with the agent", async () => {
  const { start, composerCalls, home, db } = setup();
  const out = (await call(start, { agentId: "cmp1", input: { prompt: "Fix it." } })) as { runId: string; kind: string; workspaceId: string };
  assert.deepEqual([out.kind, out.workspaceId], ["composer", home]);
  assert.deepEqual(composerCalls.map((c) => [c.workspaceId, c.mode, c.prompt, c.providerId, c.modelId, c.worker]), [[home, "agent", "Fix it.", "mock", "m", "cmp1"]]);
  assert.equal((db.prepare("SELECT agent_id, kind FROM agent_runs WHERE id = ?").get(out.runId) as { agent_id: string }).agent_id, "cmp1");
});

test("a connection no provider serves is connection_unavailable before anything starts; one removed while the start waited too", async () => {
  const none = setup(undefined, { providers: {} });
  await refused(call(none.start, { agentId: "cmp1", input: { prompt: "p" } }), "E_CONFLICT", "connection_unavailable");
  assert.deepEqual(none.composerCalls, []);
  const later = setup(undefined, {
    startComposer: async (req) => {
      delete later.providers["c"];
      req.recheck?.();
      throw new Error("not reached");
    },
  });
  await refused(call(later.start, { agentId: "cmp1", input: { prompt: "p" } }), "E_CONFLICT", "connection_unavailable");
  assert.equal(later.db.prepare("SELECT count(*) AS n FROM agent_runs").get()?.["n"], 0);
});

test("composer refusals fold into the closed reasons: model_unavailable, connection_unavailable, busy, untrusted_project, not_available", async () => {
  const { composerFailure } = await import("../../src/composer/errors.js");
  const { untrusted } = await import("../../src/gate/project-trust.js");
  const cases: Array<[unknown, string, string | undefined]> = [
    [composerFailure("E_NOT_FOUND", "model_unknown"), "E_CONFLICT", "model_unavailable"],
    [composerFailure("E_NOT_FOUND", "provider_unknown"), "E_CONFLICT", "connection_unavailable"],
    [composerFailure("E_UNAVAILABLE", "provider_unavailable"), "E_CONFLICT", "connection_unavailable"],
    [composerFailure("E_CONFLICT", "active_run"), "E_CONFLICT", "busy"],
    [composerFailure("E_BACKPRESSURE"), "E_CONFLICT", "busy"],
    [composerFailure("E_CONFLICT", "not_ready"), "E_CONFLICT", "home_unavailable"],
    [composerFailure("E_UNAVAILABLE", "worktree_unavailable"), "E_CONFLICT", "home_unavailable"],
    [composerFailure("E_UNAVAILABLE", "shutting_down"), "E_UNAVAILABLE", "not_available"],
    [untrusted(), "E_CONFLICT", "untrusted_project"],
    [composerFailure("E_CANCELLED"), "E_CANCELLED", undefined],
    [composerFailure("E_INTERNAL"), "E_INTERNAL", undefined],
  ];
  for (const [thrown, code, reason] of cases) {
    const { start } = setup(undefined, { startComposer: async () => Promise.reject(thrown) });
    await assert.rejects(call(start, { agentId: "cmp1", input: { prompt: "p" } }), (e: unknown) => {
      assert.ok(e instanceof DaemonError);
      assert.equal(e.code, code, String((thrown as Error).message));
      assert.equal(e.details?.["reason"], reason, String((thrown as Error).message));
      return true;
    });
  }
});

test("an update while the start waited: the recheck returns the NEW mode, model and provider, which the run takes", async () => {
  const fresh: unknown[] = [];
  const s = setup(undefined, {
    providers: { c: "mock", c2: "anthropic" },
    startComposer: async (req) => {
      s.journal.agents.setLaunch("cmp1", { kind: "composer", connection: "c2", modelId: "m2", mode: "ask" });
      fresh.push(req.recheck?.());
      return { run: { runId: "r-new" }, replayed: false };
    },
  });
  const out = (await call(s.start, { agentId: "cmp1", input: { prompt: "p" } })) as { runId: string };
  assert.equal(out.runId, "r-new");
  assert.deepEqual(fresh, [{ mode: "ask", modelId: "m2", providerId: "anthropic" }]);
});
