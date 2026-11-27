// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { test } from "node:test";
import { mkdirSync } from "node:fs";
import { AuditLog, openDatabase } from "@axis/audit";
import { Journal } from "@axis/journal";
import type { GitRunner } from "@axis/git-ops";
import { composeDaemonHost, type ComposeOptions, type PtyPort } from "../src/index.js";
import { hostFixture } from "../testing/host-fixture.js";

// PV-G4: the production composition keeps messaging off for worker runs unless `messaging.enabled` is set: the binding's
// `agentOf` knows no run, so no run is delivered to or offered the tools (and PV-M6's endpoint mints nothing).

const pty: PtyPort = { spawn: () => Promise.reject(new Error("unused")) };
const runner: GitRunner = { run: () => Promise.reject(new Error("unused")) };
const snapshotter: NonNullable<ComposeOptions["snapshotter"]> = () => ({ before: () => Promise.resolve(), after: () => Promise.resolve({ drift: false }) });
function options(fix: ReturnType<typeof hostFixture>, over: Partial<ComposeOptions> = {}): ComposeOptions {
  const { control: _control, ...ports } = fix.ports as typeof fix.ports & { control: unknown };
  return { config: fix.config, control: fix.client, ports, pty, ptyGitRunner: runner, snapshotter, process: new EventEmitter(), exit: () => undefined, ...over };
}

test("compose: a worker run (CLI or composer) counts for messaging only with messaging.enabled; absent or false, it does not", async () => {
  for (const [messaging, expected] of [[undefined, undefined], [{}, undefined], [{ enabled: false }, undefined], [{ enabled: true }, "w1"]] as const) {
    const fix = hostFixture();
    let agentOf: ((runId: string) => string | undefined) | undefined;
    const composed = composeDaemonHost(options(fix, { ...(messaging === undefined ? {} : { messaging }), observeMessaging: (m) => void (agentOf = m.agentOf) }));
    try {
      const services = await composed.start();
      const journal = services.journal!;
      journal.registerProject({ id: "p1", path: "/repo/p1", displayName: "p1", trusted: false, actor: "user" });
      const home = journal.createWorkspace({ projectId: "p1", branch: "axis/home", baseRef: "HEAD", baseSha: "c".repeat(40), createdBy: "user" }).value.id;
      journal.transitionWorkspace(home, "READY");
      journal.agents.create({ id: "w1", projectId: "p1", name: "W", launch: { kind: "cli", entryId: "e" }, homeWorkspaceId: home, groupId: null });
      const run = journal.createRun({ workspaceId: home, kind: "cli", createdBy: "user", agentId: "w1" }).value.id;
      assert.equal(agentOf?.(run), expected, JSON.stringify(messaging));
      // A composer worker's run alike (PV-G4 slice B).
      journal.agents.create({ id: "w2", projectId: "p1", name: "C", launch: { kind: "composer", connection: "conn", modelId: "m", mode: "agent" }, homeWorkspaceId: home, groupId: null });
      const composerRun = journal.createRun({ workspaceId: home, kind: "composer", createdBy: "user", agentId: "w2" }).value.id;
      assert.equal(agentOf?.(composerRun), expected === undefined ? undefined : "w2", `${JSON.stringify(messaging)} composer`);
    } finally {
      await composed.stop();
      fix.cleanup();
    }
  }
});

test("PV-M7 slice 2 decision A: the user's switch, read at start, turns on the CLI endpoint path alone; with messaging.enabled off no composer tool or delivery appears", async () => {
  const relayPty = { ...pty, onRelay: () => ({ dispose: () => undefined }), relay: () => true } as unknown as PtyPort;
  for (const on of [false, true]) {
    const fix = hostFixture();
    // The stored row a previous session's enable left (seeded before the first start, so the database holds no event yet).
    if (on) {
      mkdirSync(fix.dataDir, { recursive: true, mode: 0o700 });
      const db = openDatabase(join(fix.dataDir, "axis.db"));
      Journal.open(db, { audit: new AuditLog(db) });
      db.prepare("INSERT INTO messaging_cli_endpoint (id, enabled, changed_by, changed_at) VALUES (1, 1, 'user', ?)").run(new Date().toISOString());
      db.close();
    }
    let seen: { agentOf: (r: string) => string | undefined; cliAgentOf: (r: string) => string | undefined; cliWired: boolean } | undefined;
    const composed = composeDaemonHost(options(fix, { pty: relayPty, observeMessaging: (m) => void (seen = m) }));
    try {
      const journal = (await composed.start()).journal!;
      assert.equal(journal.cliEndpoint.enabled(), on, "the row as stored");
      journal.registerProject({ id: "p1", path: "/repo/p1", displayName: "p1", trusted: false, actor: "user" });
      const home = journal.createWorkspace({ projectId: "p1", branch: "axis/home", baseRef: "HEAD", baseSha: "c".repeat(40), createdBy: "user" }).value.id;
      journal.transitionWorkspace(home, "READY");
      journal.agents.create({ id: "w1", projectId: "p1", name: "W", launch: { kind: "cli", entryId: "e" }, homeWorkspaceId: home, groupId: null });
      journal.agents.create({ id: "w2", projectId: "p1", name: "C", launch: { kind: "composer", connection: "conn", modelId: "m", mode: "agent" }, homeWorkspaceId: home, groupId: null });
      const cliRun = journal.createRun({ workspaceId: home, kind: "cli", createdBy: "user", agentId: "w1" }).value.id;
      const composerRun = journal.createRun({ workspaceId: home, kind: "composer", createdBy: "user", agentId: "w2" }).value.id;
      assert.equal(seen?.cliWired, on, "read at start: the relay is wired only with the switch on");
      assert.equal(seen?.cliAgentOf(cliRun), on ? "w1" : undefined, "the CLI endpoint path finds the run's worker only with the switch on");
      // Exactly that and nothing else: the binding's agentOf (delivery into runs, the composer's send and read tools) still knows
      // no run, so no composer run is offered a message tool or delivered to, and the CLI run is not delivered to either.
      assert.equal(seen?.agentOf(composerRun), undefined, "no composer message tool or delivery");
      assert.equal(seen?.agentOf(cliRun), undefined, "no delivery into the CLI run");
    } finally {
      await composed.stop();
      fix.cleanup();
    }
  }
});
