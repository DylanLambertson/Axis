// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
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

test("compose: a worker run counts for messaging only with messaging.enabled; absent or false, it does not", async () => {
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
    } finally {
      await composed.stop();
      fix.cleanup();
    }
  }
});
