// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { GitRunner } from "@axis/git-ops";
import { composeDaemonHost, type ComposeOptions, type PtyPort } from "../src/index.js";
import { hostFixture } from "../testing/host-fixture.js";

// PV-M3 slice 2 in the composed host: a delivery whose ack never landed is released when the host starts again, so the
// message goes to a later run; an acknowledged delivery is kept.

const pty: PtyPort = { spawn: () => Promise.reject(new Error("unused")) };
const runner: GitRunner = { run: () => Promise.reject(new Error("unused")) };
const snapshotter: NonNullable<ComposeOptions["snapshotter"]> = () => ({ before: () => Promise.resolve(), after: () => Promise.resolve({ drift: false }) });
const id = (kind: "thr" | "msg", n: number): string => `${kind}_${String(n).padStart(21, "0")}A`;

test("host start releases every lease and keeps every acknowledgement", async () => {
  const fix = hostFixture();
  const compose = () => {
    const { control: _control, ...ports } = fix.ports as typeof fix.ports & { control: unknown };
    return composeDaemonHost({ config: fix.config, control: fix.client, ports, pty, ptyGitRunner: runner, snapshotter, process: new EventEmitter(), exit: () => undefined });
  };
  try {
    const first = compose();
    const s1 = await first.start();
    const journal = s1.journal!;
    journal.registerProject({ id: "p1", path: "/repo/one", displayName: "One", trusted: false, actor: "user" });
    const ws = journal.createWorkspace({ projectId: "p1", branch: "axis/m", baseRef: "HEAD", baseSha: "c".repeat(40), createdBy: "user" }).value.id;
    journal.transitionWorkspace(ws, "READY");
    const run = journal.composer.createRun({ workspaceId: ws, createdBy: "user" }, { mode: "agent", providerId: "mock", modelId: "mock-model" }).value.id;
    for (const n of [1, 2]) {
      journal.messages.append({
        thread: n === 1 ? { create: true, id: id("thr", 1), projectId: "p1" } : { create: false, id: id("thr", 1) },
        join: n === 1 ? ["user", "agent:a1"] : [],
        message: { id: id("msg", n), sender: { kind: "user", verified: true }, senderKey: "user", recipients: [{ agent: "a1" }], expanded: [{ kind: "agent", agentId: "a1" }], body: `m${n}`, refs: [], inReplyTo: null, hop: 0 },
        to: [{ principal: "agent:a1", counted: false }],
      });
      journal.messages.deliveries.lease(id("msg", n), "agent:a1", run);
    }
    journal.messages.deliveries.ack(run, [id("msg", 1)]);
    const head = s1.audit!.head();
    await first.stop();
    fix.supervisor.anchor = head; // the supervisor holds the last anchor, as after a clean stop

    const second = compose();
    const s2 = await second.start();
    try {
      assert.equal(s2.degraded, undefined);
      const d = s2.journal!.messages.deliveries;
      assert.equal(d.get(id("msg", 1), "agent:a1")?.state, "acked");
      assert.equal(d.get(id("msg", 2), "agent:a1"), undefined, "released: it goes to a later run");
      assert.deepEqual(d.pending("agent:a1", 5).map((p) => p.messageId), [id("msg", 2)]);
    } finally {
      await second.stop();
    }
  } finally {
    fix.cleanup();
  }
});
