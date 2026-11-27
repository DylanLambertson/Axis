// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The rig of a plugin's axis.runs/1.start through the real pipeline (PV-K1e-b, PV-K2 K2-g4b): the policy, the content hook, the
// gate with the plugin binding, the handler, and the host windows' lifetimes fed by the daemon's session lifecycle. The composer
// service is a recording fake that makes the real service's synchronous checks (the signal, the grant, the host window); K1e-a and
// composer-plugin-start.test.ts test the real one. A desktop session of the host window `w1` is open from the start.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { MessagePort } from "node:worker_threads";
import type { TestContext } from "node:test";
import { AuditLog, openDatabase } from "@axis/audit";
import { Daemon, MemoryIdempotencyStore, memoryPair, protocolRegistry, type HandlerContext, type Identity, type IdentityVerifier } from "@axis/daemon";
import { Journal } from "@axis/journal";
import type { ComposerRun } from "@axis/protocol";
import { createApprovals, createApprovalsHandlers, InMemoryTrustRegistry, RULES, RuleTablePolicy, type NativeControl } from "../src/index.js";
import { composerFailure } from "../src/composer/errors.js";
import { pluginRunStartChallenges } from "../src/gate/plugin-run-start.js";
import { createComposerRunsHandlers, registerComposerRunsHandlers } from "../src/handlers/composer-runs.js";
import { registerPluginsHandlers } from "../src/handlers/plugins.js";
import { createWindowLifetimes } from "../src/plugins/window-lifetimes.js";
import type { ComposerStartInput } from "../src/ports/composer.js";
import { ProjectMutex } from "../src/worktrees/project-mutex.js";
import { Client } from "./approvals-rig.js";
import { fakeClock } from "./helpers.js";
import { grantForTests, enableForTests } from "./plugin-grants-for-tests.js";

export type Row = Record<string, unknown>;
const SHA = "b".repeat(40);
export const PLUGIN_ATT = "plugin:acme.board#Pacme#p7#w1#p1";

export const verifier: IdentityVerifier = {
  verify(att) {
    if (typeof att !== "string") return undefined;
    const [actor, conn, windowId, host, project] = att.split("#");
    if (actor?.startsWith("plugin:") === true) {
      return { connectionId: (conn as string).padEnd(22, "_"), windowId: windowId as string, actorId: actor, actor: actor as Identity["actor"], workspaceId: project as string, trusted: false, clientKind: "plugin", hostWindowId: host as string };
    }
    return { connectionId: (conn as string).padEnd(22, "_"), windowId: windowId as string, actorId: "user-id", actor: "user", trusted: true, clientKind: windowId === "web" ? "web" : "desktop" };
  },
};

export interface SetupOptions {
  /** Inside the trust gate's admit (the handler holds the project mutex). */
  readonly admit?: () => Promise<void>;
  /** Each daemon audit row; the daemon awaits a returned promise (a pause at that row). */
  readonly onAudit?: (e: Row) => void | Promise<void>;
}

export async function setup(t: TestContext, over: SetupOptions = {}) {
  const clock = fakeClock();
  const db = openDatabase(":memory:");
  const journal = Journal.open(db, { audit: new AuditLog(db) });
  for (const [id, name] of [["p1", "One"], ["p2", "Two"]] as const) journal.registerProject({ id, path: `/repo/${id}`, displayName: name, trusted: false, actor: "user" });
  const ws = (projectId: string) => {
    const w = journal.createWorkspace({ projectId, branch: `feature-${projectId}`, baseRef: "main", baseSha: SHA, createdBy: "user" }).value;
    journal.transitionWorkspace(w.id, "READY");
    return w.id;
  };
  const ws1 = ws("p1");
  const ws2 = ws("p2");
  const ws1b = ws("p1");
  journal.plugins.add("acme.board", "p1");
  enableForTests(journal.plugins, "acme.board", "p1");
  grantForTests(journal.plugins, "acme.board", "p1", "runs.start");
  const windows = createWindowLifetimes({ randomBytes: (n) => randomBytes(n) });
  const control: NativeControl = { nativeConfirm: () => new Promise(() => undefined) };
  const approvals = createApprovals({ audit: { append() {} }, control, clock, plugins: pluginRunStartChallenges(journal, journal.pluginIssues, () => clock.now(), windows) });
  const daemon = new Daemon({ identity: verifier, audit: { append: (e) => over.onAudit?.(e as unknown as Row) }, registry: protocolRegistry, idempotency: new MemoryIdempotencyStore(), policy: new RuleTablePolicy(new InMemoryTrustRegistry(), RULES, journal.plugins), approvals: approvals.gate, lifecycle: windows });
  daemon.register("axis.approvals", 1, createApprovalsHandlers({ approvals: approvals.port }));
  // The user's plugin decreases (PV-K2 K2-g1), so a revoke can follow a plugin's run start.
  // ONE project mutex for the plugin handlers and the plugin start, as in the composition (audit A, L2).
  const mutex = new ProjectMutex();
  registerPluginsHandlers({ register: (c, v, h, o) => (o === undefined ? daemon.register(c, v, h) : daemon.register(c, v, h, o)) }, { journal, mutex, endPlugin: (p, j) => approvals.endPlugin(p, j) });
  const starts: ComposerStartInput[] = [];
  const admitted: unknown[] = [];
  const run = (input: ComposerStartInput): ComposerRun => ({ runId: randomUUID(), workspaceId: input.workspaceId, mode: input.mode, providerId: input.providerId, modelId: input.modelId, state: "QUEUED", reason: null, createdAt: "2026-11-26T00:00:00.000Z", startedAt: null, endedAt: null, live: true, awaitingApproval: false, usage: null });
  const none = (): never => assert.fail("not used");
  const cancels: string[] = [];

  registerComposerRunsHandlers(
    { register: (c, v, h, o) => (o === undefined ? daemon.register(c, v, h) : daemon.register(c, v, h, o)) },
    {
      service: {
        cancel: (id: string) => (cancels.push(id), none()), get: none, list: none, events: none,
        start: async (input, signal) => {
          if (signal.aborted) throw composerFailure("E_CANCELLED");
          if (input.grantHolds !== undefined && input.grantHolds() !== true) throw composerFailure("E_CONFLICT", "grant_changed");
          if (input.hostAlive !== undefined && input.hostAlive() !== true) throw composerFailure("E_CONFLICT", "host_window_closed");
          starts.push(input);
          return { run: run(input), replayed: false };
        },
      },
      gate: { admit: async (q: { caller: unknown }) => { admitted.push(q.caller); await over.admit?.(); return "ticket"; } } as never,
      journal,
      mutex,
      pluginStarts: journal,
      hostWindows: windows,
    },
  );
  const ports: MessagePort[] = [];
  const connect = async (att: string): Promise<Client> => {
    const { client, server } = memoryPair();
    ports.push(client);
    const c = new Client(client);
    daemon.accept(server, att);
    await c.hello();
    return c;
  };
  t.after(() => {
    approvals.dispose();
    daemon.stop();
    for (const p of ports) p.close();
    db.close();
  });
  const body = (workspaceId = ws1, over: Row = {}) => ({ workspaceId, mode: "edit", prompt: "Summarise the open tasks", providerId: "mock", modelId: "mock-model", ...over });
  // The host window `w1` is open: a plugin view lives in a window that has a desktop session.
  const host = await connect("user#Hhost#w1");
  return { clock, journal, db, daemon, approvals, windows, mutex, starts, admitted, connect, host, body, ws1, ws2, ws1b, cancels };
}
export type Setup = Awaited<ReturnType<typeof setup>>;

export const reason = (m: { error?: { details?: Record<string, unknown> } }): unknown => m.error?.details?.["reason"];

/** Wait until a condition holds (a close is reported asynchronously). */
export async function until(pred: () => boolean, what: string, guardMs = 5000): Promise<void> {
  const end = performance.now() + guardMs;
  while (!pred()) {
    if (performance.now() > end) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

export function handlerRig(s: Setup, mutex = new ProjectMutex()) {
  const seen: ComposerStartInput[] = [];
  const handlers = createComposerRunsHandlers({
    // A service that does NOT check `grantHolds` or `hostAlive`, so only the handler's own checks are under test.
    service: { cancel: () => assert.fail("no"), get: () => assert.fail("no"), list: () => assert.fail("no"), events: () => assert.fail("no"), start: async (input) => (seen.push(input), { run: { runId: randomUUID(), workspaceId: input.workspaceId, mode: input.mode, providerId: input.providerId, modelId: input.modelId, state: "QUEUED", reason: null, createdAt: "2026-11-26T00:00:00.000Z", startedAt: null, endedAt: null, live: true, awaitingApproval: false, usage: null }, replayed: false }) },
    gate: { admit: async () => "ticket" } as never,
    journal: s.journal,
    mutex,
    pluginStarts: s.journal,
    hostWindows: s.windows,
  });
  // What the gate hands the handler on a spend: the capability the binding minted at issue (here, for the rig's own workspace).
  const asPlugin = verifier.verify(PLUGIN_ATT) as Identity;
  const mint = () => pluginRunStartChallenges(s.journal, s.journal.pluginIssues, () => 1, s.windows).bind({ identity: asPlugin, actor: asPlugin.actor, contract: "axis.runs", method: "start", args: s.body() } as never, { target: "x", contentDigest: "e".repeat(64) })?.approved;
  const ctx = (identity: Identity, approved: unknown = mint(), signal: AbortSignal = new AbortController().signal): HandlerContext => ({ identity, requestId: "r", correlationId: "x", signal, ...(approved === false ? {} : { approved: { target: "x", capability: approved } }) }) as unknown as HandlerContext;
  return { handlers, seen, ctx, mutex, mint };
}
