// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// DC-3a/DC-3c's composition: a host serves axis.terminals/1 only with all four terminal-port parts AND a trust registry with
// onRevoked (the routing is then installed on it) AND DC-3b's data-port broker attestation; with any missing, the contract is
// dropped from what it serves and the host still starts. The wiring pieces: a CLI run's terminal is recorded when it
// spawns, and project untrust reaches the plain terminals synchronously, before the run stop and whatever it throws.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { GitRunner } from "@axis/git-ops";
import { composeDaemonHost, type ComposeOptions } from "../../src/index.js";
import { InMemoryTrustRegistry } from "../../src/policy/trust-registry.js";
import { hostTerminals, installTerminals, recordRunTerminals, withTerminalFanOut } from "../../src/terminals/compose.js";
import { hostFixture } from "../../testing/host-fixture.js";
import { FakeHandle, FakeTerminalPort } from "./fakes.js";

const runner: GitRunner = { run: () => Promise.reject(new Error("unused")) };
const snapshotter: NonNullable<ComposeOptions["snapshotter"]> = () => ({ before: () => Promise.resolve(), after: () => Promise.resolve({ drift: false }) });

const NONE = Symbol("no broker");
async function served(pty: unknown, trust?: unknown, broker: unknown = { dataBroker: true }): Promise<readonly string[]> {
  const fix = hostFixture();
  const { control: _control, ...ports } = fix.ports as typeof fix.ports & { control: unknown };
  const composed = composeDaemonHost({ config: fix.config, control: fix.client, ports: { ...ports, ...(trust === undefined ? {} : { trust: trust as never }) }, pty: pty as never, ptyGitRunner: runner, snapshotter, process: new EventEmitter(), exit: () => undefined, ...(broker === NONE ? {} : { terminalDataBroker: broker as never }) });
  try {
    return (await composed.start()).served;
  } finally {
    await composed.stop();
    fix.cleanup();
  }
}

test("DC-3c decision (a): not served without DC-3b's data-port broker attestation, even with every other part; the host starts", async () => {
  const s = await served(new FakeTerminalPort(), undefined, NONE);
  assert.equal(s.includes("axis.terminals"), false);
  assert.ok(s.includes("axis.cli-runs"));
  assert.equal((await served(new FakeTerminalPort(), undefined, { dataBroker: "yes" })).includes("axis.terminals"), false, "only the literal attestation");
});

test("served with all four port parts, the default trust registry (which offers onRevoked) and the broker attestation; the rest as before", async () => {
  const s = await served(new FakeTerminalPort());
  assert.equal(s.includes("axis.terminals"), true);
  assert.ok(s.includes("axis.cli-runs"));
});

test("not served, and the host still starts, with an ordinary CLI port or a trust registry without onRevoked", async () => {
  assert.equal((await served({ spawn: () => Promise.reject(new Error("unused")) })).includes("axis.terminals"), false, "a port without the parts");
  const plainTrust = { isTrusted: () => false, isRevoked: () => true, set: () => undefined };
  assert.equal((await served(new FakeTerminalPort(), plainTrust)).includes("axis.terminals"), false, "a registry without onRevoked");
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

test("review nit 3: at shutdown the routing is disposed FIRST, then the registry closes what is left", () => {
  const terms = hostTerminals(new FakeTerminalPort());
  assert.ok(terms !== undefined);
  const trust = new InMemoryTrustRegistry();
  const cleanups: Array<() => void> = [];
  const routing = installTerminals(terms, trust, () => undefined, () => undefined, cleanups);
  assert.ok(routing !== undefined && routing.active());
  let activeAtShutdown: boolean | undefined;
  const shutdown = terms.registry.shutdown.bind(terms.registry);
  terms.registry.shutdown = () => ((activeAtShutdown = routing.active()), shutdown());
  for (const c of cleanups) c();
  assert.equal(activeAtShutdown, false, "the routing was already disposed when the registry shut down");
});
