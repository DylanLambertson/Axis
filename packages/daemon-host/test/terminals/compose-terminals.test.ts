// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// DC-3a's composition: until DC-3c's routing exists, a host whose pty port has all four terminal parts still serves no
// axis.terminals/1 (planned; nothing registers), and starts cleanly. The wiring pieces: a CLI run's terminal is recorded when it
// spawns, and project untrust reaches the plain terminals synchronously, before the run stop and whatever it throws.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { GitRunner } from "@axis/git-ops";
import { composeDaemonHost, type ComposeOptions } from "../../src/index.js";
import { hostTerminals, recordRunTerminals, withTerminalFanOut } from "../../src/terminals/compose.js";
import { hostFixture } from "../../testing/host-fixture.js";
import { FakeHandle, FakeTerminalPort } from "./fakes.js";

const runner: GitRunner = { run: () => Promise.reject(new Error("unused")) };
const snapshotter: NonNullable<ComposeOptions["snapshotter"]> = () => ({ before: () => Promise.resolve(), after: () => Promise.resolve({ drift: false }) });

test("a host with a fully terminal-capable pty port, and no DC-3c routing, serves no axis.terminals/1 and starts", async () => {
  const fix = hostFixture();
  const { control: _control, ...ports } = fix.ports as typeof fix.ports & { control: unknown };
  const composed = composeDaemonHost({ config: fix.config, control: fix.client, ports, pty: new FakeTerminalPort(), ptyGitRunner: runner, snapshotter, process: new EventEmitter(), exit: () => undefined });
  try {
    const s = await composed.start();
    assert.equal(s.served.includes("axis.terminals"), false);
    assert.ok(s.served.includes("axis.cli-runs"), "the rest is served as before");
  } finally {
    await composed.stop();
    fix.cleanup();
  }
});

test("hostTerminals exists only for a port with all four parts", () => {
  assert.ok(hostTerminals(new FakeTerminalPort()) !== undefined);
  assert.equal(hostTerminals({ spawn: () => Promise.reject(new Error("x")) }), undefined, "an ordinary CLI port keeps working without it");
});

test("a CLI run's terminal is recorded at spawn against its run; a run the journal cannot place is not, and the spawn is unchanged", async () => {
  const terms = hostTerminals(new FakeTerminalPort());
  assert.ok(terms !== undefined);
  const h = new FakeHandle();
  const inner = { spawn: async () => h };
  const wrapped = recordRunTerminals(inner, terms, (runId) => (runId === "run1" ? { workspaceId: "ws1", projectId: "p1" } : undefined));
  const spec = { runId: "run1", argv: ["/bin/x"], cwd: "/w", env: {}, cols: 80, rows: 24 };
  assert.equal(await wrapped.spawn(spec), h);
  assert.deepEqual(terms.registry.list().map((t) => [t.terminalId, t.kind, t.runId, t.workspaceId]), [[h.terminalId, "cli-run", "run1", "ws1"]]);
  const other = new FakeHandle();
  const unplaced = recordRunTerminals({ spawn: async () => other }, terms, () => undefined);
  assert.equal(await unplaced.spawn({ ...spec, runId: "run2" }), other);
  assert.equal(terms.registry.list().length, 1);
  assert.equal(recordRunTerminals(inner, undefined, () => undefined), inner, "no terminals: the port is unchanged");
});

test("project untrust: the terminals are abandoned and closed synchronously, before the run stop, and a failure never stops the other", () => {
  const terms = hostTerminals(new FakeTerminalPort());
  assert.ok(terms !== undefined);
  const op = terms.registry.reserve("ws1", "p1");
  assert.ok(op !== undefined);
  const live = new FakeHandle();
  assert.ok(terms.registry.publish(op, live) !== undefined);
  const order: string[] = [];
  const stop = withTerminalFanOut((id) => order.push(`runs:${id}:${terms.registry.get(live.terminalId)?.state}`), terms);
  stop("p1");
  assert.deepEqual(order, ["runs:p1:closed"], "the terminal was closed before the run stop was called");
  // A registry that throws still lets the runs stop.
  const broken = { registry: { projectRevoked: () => { throw new Error("x"); } }, port: new FakeTerminalPort() } as never;
  const seen: string[] = [];
  withTerminalFanOut((id) => seen.push(id), broken)("p2");
  assert.deepEqual(seen, ["p2"]);
});
