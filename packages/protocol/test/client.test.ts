// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AxisPortClient, ClientError, type ClientPort, type ClientTimers } from "../src/client.js";

/** The renderer's end of a port, driven by the test as the daemon. */
class Port implements ClientPort {
  readonly sent: Array<Record<string, unknown>> = [];
  closed = false;
  readonly #msg = new Set<(d: unknown) => void>();
  readonly #close = new Set<() => void>();
  postMessage(m: unknown): void {
    if (this.closed) throw new Error("closed");
    this.sent.push(m as Record<string, unknown>);
  }
  onMessage(h: (d: unknown) => void): () => void {
    this.#msg.add(h);
    return () => void this.#msg.delete(h);
  }
  onClose(h: () => void): () => void {
    this.#close.add(h);
    return () => void this.#close.delete(h);
  }
  close(): void {
    this.closed = true;
  }
  daemon(m: unknown): void {
    for (const h of [...this.#msg]) h(m);
  }
  hangUp(): void {
    this.closed = true;
    for (const h of [...this.#close]) h();
  }
  listeners(): number {
    return this.#msg.size + this.#close.size;
  }
}

class Timers implements ClientTimers {
  readonly #t = new Map<number, () => void>();
  #n = 0;
  readonly delays: number[] = [];
  set(fn: () => void, ms: number): unknown {
    this.delays.push(ms);
    this.#t.set(++this.#n, fn);
    return this.#n;
  }
  clear(h: unknown): void {
    this.#t.delete(h as number);
  }
  fire(): void {
    for (const [k, f] of [...this.#t]) {
      this.#t.delete(k);
      f();
    }
  }
  get pending(): number {
    return this.#t.size;
  }
}

const WELCOME = { type: "welcome", protocolVersion: 1, contracts: [{ id: "axis.projects", version: 1 }], limits: { maxMessageBytes: 1_000_000, maxInFlight: 8, maxTimeoutMs: 30_000 } };
const CONTRACTS = [{ id: "axis.projects", versions: [1] }];
const ERR = { code: "E_POLICY_DENIED", message: "Denied", retryable: false, correlationId: "c1" };

async function opened(timers = new Timers()) {
  const port = new Port();
  const p = AxisPortClient.open(port, { contracts: CONTRACTS, timers });
  assert.deepEqual(port.sent[0], { type: "hello", protocolVersions: [1], contracts: [{ id: "axis.projects", versions: [1] }] });
  port.daemon(WELCOME);
  return { client: await p, port, timers };
}

test("open: a parsed welcome opens the client; the hello timer is cleared", async () => {
  const { client, timers } = await opened();
  assert.deepEqual(client.welcome.contracts, [{ id: "axis.projects", version: 1 }]);
  assert.equal(timers.pending, 0);
});

test("open: hello-rejected, a first message that is not a welcome, a close and no answer all reject and close the port", async () => {
  const cases: Array<[(p: Port, t: Timers) => void, string, string]> = [
    [(p) => p.daemon({ type: "hello-rejected", error: { ...ERR, code: "E_UNAUTHENTICATED" } }), "E_UNAUTHENTICATED", "rejected"],
    [(p) => p.daemon({ ...WELCOME, extra: 1 }), "E_UNAUTHENTICATED", "bad_first_message"],
    [(p) => p.daemon({ v: 1, id: "c1", ok: true, result: {} }), "E_UNAUTHENTICATED", "bad_first_message"],
    [(p) => p.hangUp(), "E_UNAUTHENTICATED", "rejected"],
    [(_p, t) => t.fire(), "E_TIMEOUT", "no_welcome"],
  ];
  for (const [act, code, reason] of cases) {
    const port = new Port();
    const timers = new Timers();
    const p = AxisPortClient.open(port, { contracts: CONTRACTS, timers });
    act(port, timers);
    await assert.rejects(p, (e: unknown) => e instanceof ClientError && e.code === code && e.reason === reason);
    assert.equal(port.closed, true);
    assert.equal(port.listeners(), 0, "no listener left");
    assert.equal(timers.pending, 0);
  }
});

test("call: the envelope is the protocol's, an ok answer is checked against the method's response schema, an error answer is passed through", async () => {
  const { client, port, timers } = await opened();
  const a = client.call("axis.projects", "list", {}, { idempotencyKey: "00000000-0000-4000-8000-000000000000", timeoutMs: 1000 });
  assert.deepEqual(port.sent[1], { v: 1, id: "c1", contract: "axis.projects", contractVersion: 1, method: "list", payload: {}, idempotencyKey: "00000000-0000-4000-8000-000000000000", timeoutMs: 1000 });
  assert.equal(timers.delays.at(-1), 6000, "the call's own timeout plus the margin");
  port.daemon({ v: 1, id: "c1", ok: true, result: { projects: [] } });
  assert.deepEqual(await a, { ok: true, result: { projects: [] } });
  const b = client.call("axis.projects", "list", {});
  port.daemon({ v: 1, id: "c2", ok: false, error: ERR });
  assert.deepEqual(await b, { ok: false, error: ERR });
  const c = client.call("axis.projects", "list", {});
  port.daemon({ v: 1, id: "c3", ok: true, result: { projects: "nope" } });
  await assert.rejects(c, (e: unknown) => e instanceof ClientError && e.reason === "bad_answer");
  const d = client.call("axis.projects", "list", {});
  port.daemon({ id: "c4", ok: true });
  await assert.rejects(d, (e: unknown) => e instanceof ClientError && e.reason === "bad_answer");
  // An answer for no waiting call is ignored.
  port.daemon({ v: 1, id: "c99", ok: true, result: {} });
  assert.equal(timers.pending, 0);
});

test("call: an unserved contract or method, a bad timeout and a full table refuse before anything is sent", async () => {
  const { client, port } = await opened();
  const before = port.sent.length;
  await assert.rejects(client.call("axis.git", "push", {}), (e: unknown) => e instanceof ClientError && e.code === "E_METHOD_NOT_FOUND");
  await assert.rejects(client.call("axis.projects", "nope", {}), (e: unknown) => e instanceof ClientError && e.code === "E_METHOD_NOT_FOUND");
  await assert.rejects(client.call("axis.projects", "list", {}, { timeoutMs: 30_001 }), (e: unknown) => e instanceof ClientError && e.code === "E_INVALID_ARGUMENT");
  assert.equal(port.sent.length, before);
  const small = new Port();
  const p = AxisPortClient.open(small, { contracts: CONTRACTS, timers: new Timers(), maxPending: 2 });
  small.daemon(WELCOME);
  const c = await p;
  void c.call("axis.projects", "list", {}).catch(() => undefined);
  void c.call("axis.projects", "list", {}).catch(() => undefined);
  await assert.rejects(c.call("axis.projects", "list", {}), (e: unknown) => e instanceof ClientError && e.code === "E_BACKPRESSURE");
});

test("call: an abort sends cancel and fails the call; a timeout fails it; a close fails everything waiting and every later call", async () => {
  const { client, port, timers } = await opened();
  const ac = new AbortController();
  const a = client.call("axis.projects", "list", {}, { signal: ac.signal });
  ac.abort();
  await assert.rejects(a, (e: unknown) => e instanceof ClientError && e.code === "E_CANCELLED");
  assert.deepEqual(port.sent.at(-1), { v: 1, cancel: "c1" });
  port.daemon({ v: 1, id: "c1", ok: true, result: { projects: [] } }); // late: ignored
  const b = client.call("axis.projects", "list", {});
  timers.fire();
  await assert.rejects(b, (e: unknown) => e instanceof ClientError && e.code === "E_TIMEOUT");
  const c = client.call("axis.projects", "list", {});
  port.hangUp();
  await assert.rejects(c, (e: unknown) => e instanceof ClientError && e.code === "E_UNAVAILABLE");
  assert.equal(client.closed, true);
  assert.equal(port.listeners(), 0);
  await assert.rejects(client.call("axis.projects", "list", {}), (e: unknown) => e instanceof ClientError && e.code === "E_UNAVAILABLE");
});
