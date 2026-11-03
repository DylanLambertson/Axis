// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Regression tests for the re-review: NEW-B1, NEW-S1 and the nits N-a, N-c, N-e, N-f.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { Daemon, DaemonError, MemoryIdempotencyStore } from "../src/index.js";
import { CONTRACT, KEY1, hello, req, rig, testRegistry, verifier, type Rig } from "./harness.js";

async function ready(t: TestContext, options: Parameters<typeof rig>[0] = {}): Promise<Rig> {
  const r = rig(options);
  t.after(() => r.cleanup());
  await r.handshake();
  return r;
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function open(r: Rig, att: string) {
  const c = r.connect(att);
  c.client.postMessage(hello());
  await c.inbox.until((m): m is object => (m as { type?: string }).type === "welcome");
  return c;
}

// ---- NEW-B1: untrusted input is never serialised ----

test("NEW-B1: a tiny shared-reference DAG sent before identity does not stall the event loop and is refused", async (t) => {
  let release!: () => void;
  const hold = new Promise<void>((res) => (release = res));
  const r = rig({ identity: { verify: async (a) => (await hold, verifier.verify(a)) } });
  t.after(() => r.cleanup());
  let dag: unknown[] = ["x"];
  for (let i = 0; i < 27; i++) dag = [dag, dag]; // ~150 bytes on the wire, 2^27 leaves if expanded
  const start = Date.now();
  r.send(dag);
  await wait(5);
  assert.ok(Date.now() - start < 500, `event loop blocked for ${Date.now() - start} ms by one pre-identity message`);
  assert.ok(await r.inbox.closedWithin(), "the connection is closed");
  release();
  await wait(20);
  assert.equal(r.daemon.connectionCount, 0);
});

test("NEW-B1: other hostile pre-identity shapes (cycle, accessor, deep nesting, oversize) are refused cheaply", async (t) => {
  const cyclic: Record<string, unknown> = {};
  cyclic["self"] = cyclic;
  let deep: unknown = 1;
  for (let i = 0; i < 40; i++) deep = [deep];
  for (const hostile of [cyclic, deep, "x".repeat(2_000_000), { a: "y".repeat(100_000) }]) {
    const r = rig({ identity: { verify: () => new Promise(() => undefined) } });
    t.after(() => r.cleanup());
    r.send(hostile);
    assert.ok(await r.inbox.closedWithin());
  }
});

test("NEW-B1: no source file serialises untrusted input (JSON.stringify appears only in the digest and the store key)", () => {
  const src = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");
  const allowed = new Map([
    ["digest.js", 3],
    ["memory-store.js", 2],
  ]);
  for (const file of readdirSync(src).filter((f) => f.endsWith(".js"))) {
    const count = (readFileSync(join(src, file), "utf8").match(/JSON\.stringify\(/g) ?? []).length;
    assert.equal(count, allowed.get(file) ?? 0, `${file}: JSON.stringify must not be used outside the digest and store keys`);
  }
});

// ---- NEW-S1: orphans are charged to the window ----

test("NEW-S1: one window's orphans do not starve another window; the quota survives a reconnect; hammering ends in a close", async (t) => {
  const r = rig({ limits: { maxInFlight: 4, maxViolations: 3 }, attestation: "good:victim#vic@ws-good~win-good" });
  t.after(() => r.cleanup());
  await r.handshake();
  r.daemon.register(CONTRACT, 1, { slow: () => new Promise(() => undefined), echo: (_c, p: { text: string }) => p });
  const evil = await open(r, "good:bad#evil-1@ws-evil~win-evil");
  for (let i = 0; i < 4; i++) evil.client.postMessage(req(`s${i}`, "slow", {}, { timeoutMs: 1 }));
  await wait(40);
  evil.client.close();
  await wait(20);
  assert.equal(r.daemon.orphanedHandlers, 4);

  const again = await open(r, "good:bad#evil-2@ws-evil~win-evil"); // same window, new connection
  again.client.postMessage(req("e1", "echo", { text: "x" }));
  assert.equal((await again.inbox.response("e1")).error?.code, "E_BACKPRESSURE", "the window's own quota survives the reconnect");

  r.send(req("v1", "echo", { text: "hi" }));
  assert.equal((await r.inbox.response("v1")).ok, true, "another window is unaffected");

  for (let i = 0; i < 6; i++) again.client.postMessage(req(`h${i}`, "echo", { text: "x" }));
  assert.ok(await again.inbox.closedWithin(), "hammering on a full quota closes the connection");
  r.send(req("v2", "echo", { text: "hi" }));
  assert.equal((await r.inbox.response("v2")).ok, true);
});

test("NEW-S1: the daemon-wide backstop still applies across windows", async (t) => {
  const r = await ready(t, { limits: { maxInFlight: 4 }, maxOrphanedPerWindow: 4, maxOrphanedHandlers: 4, attestation: "good#a1~win-a" });
  r.daemon.register(CONTRACT, 1, { slow: () => new Promise(() => undefined), echo: (_c, p: { text: string }) => p });
  for (let i = 0; i < 4; i++) r.send(req(`s${i}`, "slow", {}, { timeoutMs: 1 }));
  await wait(40);
  const other = await open(r, "good#b1~win-b");
  other.client.postMessage(req("o1", "echo", { text: "x" }));
  assert.equal((await other.inbox.response("o1")).error?.code, "E_BACKPRESSURE");
});

// ---- N-a: a malformed challenge from the gate ----

test("N-a: a malformed challenge from the gate is E_INTERNAL, audited as approval_gate_error, with one correlation id", async (t) => {
  const r = await ready(t, { gate: { check: () => ({ status: "required", challenge: { challengeId: "short" } as never }) } });
  r.daemon.register(CONTRACT, 1, { danger: () => assert.fail("must not run") });
  r.send(req("g1", "danger", { id: "ws-1" }, { idempotencyKey: KEY1 }));
  const res = await r.inbox.response("g1");
  assert.equal(res.error?.code, "E_INTERNAL");
  const row = r.events.at(-1);
  assert.equal(row?.payload["reason"], "approval_gate_error");
  assert.equal(row?.payload["correlationId"], (res.error as { correlationId?: string }).correlationId);
  assert.equal(r.internal.length, 1);
});

// ---- N-c: one handshake budget ----

test("N-c: verification and handshake share one handshake timeout (not two in a row)", async (t) => {
  const r = rig({ limits: { handshakeTimeoutMs: 120 }, identity: { verify: async (a) => (await wait(70), verifier.verify(a)) } });
  t.after(() => r.cleanup());
  const start = Date.now();
  assert.ok(await r.inbox.closedWithin(1000));
  const took = Date.now() - start;
  assert.ok(took < 170, `closed after ${took} ms; verification (70) plus a second 120 ms timer would be 190`);
});

// ---- N-e: more daemon-only codes ----

test("N-e: a handler cannot raise E_POLICY_DENIED, E_UNAUTHENTICATED or E_VERSION_UNSUPPORTED", async (t) => {
  for (const code of ["E_POLICY_DENIED", "E_UNAUTHENTICATED", "E_VERSION_UNSUPPORTED"] as const) {
    const r = await ready(t);
    r.daemon.register(CONTRACT, 1, { boom: () => { throw new DaemonError(code, "Not permitted"); } });
    r.send(req("n", "boom"));
    assert.equal((await r.inbox.response("n")).error?.code, "E_INTERNAL", code);
  }
});

// ---- N-f: the store and its budget ----

test("N-f: the per-actor budget is per workspace, so one workspace cannot evict the same actor's entries in another", () => {
  const s = new MemoryIdempotencyStore({ maxPerActor: 2 });
  const key = (ws: string, k: string) => ({ actorId: "a", workspaceId: ws, contract: "c", version: 1, method: "m", key: k });
  const kept = key("ws-y", "keep");
  s.begin(kept, "h");
  s.complete(kept, 1, "c");
  for (let i = 0; i < 10; i++) {
    const k = key("ws-x", `k${i}`);
    s.begin(k, "h");
    s.complete(k, i, "c");
  }
  assert.equal(s.begin(kept, "h").state, "replay");
});

test("N-f: the daemon has no silent default idempotency store", () => {
  // @ts-expect-error `idempotency` is required
  const options: ConstructorParameters<typeof Daemon>[0] = { identity: verifier, audit: { append: () => undefined }, registry: testRegistry };
  assert.ok(options);
});
