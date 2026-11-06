// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { startWebHost, type WebHost } from "../src/web/index.js";
import { TestSupervisor } from "../testing/test-supervisor.js";
import { ORIGIN } from "./web-helpers.js";

/**
 * End to end over real processes and a real loopback socket: a host child process (the control-channel echo host, which runs
 * the real ChannelMux, connect router, limiter and attestation verifier) under the test supervisor, the web host on the
 * supervisor's mux and key, and the platform WebSocket client.
 */

interface Client {
  readonly ws: WebSocket;
  readonly opened: Promise<string>;
  next(): Promise<unknown>;
  readonly closed: Promise<number>;
}

function open(host: WebHost, token: string, origin = ORIGIN): Client {
  const Ctor = WebSocket as unknown as new (url: string, init: { protocols: string[]; headers: Record<string, string> }) => WebSocket;
  const ws = new Ctor(`ws://127.0.0.1:${host.address.port}/axis/1`, { protocols: ["axis.v1", `axis.auth.${token}`], headers: { origin } });
  const inbox: unknown[] = [];
  const waiters: Array<(m: unknown) => void> = [];
  ws.onmessage = (e: MessageEvent) => {
    const m = JSON.parse(String(e.data)) as unknown;
    const w = waiters.shift();
    if (w !== undefined) w(m);
    else inbox.push(m);
  };
  return {
    ws,
    opened: new Promise((resolve, reject) => {
      ws.onopen = () => resolve(ws.protocol);
      ws.onerror = () => reject(new Error("refused"));
    }),
    next: () => (inbox.length > 0 ? Promise.resolve(inbox.shift()) : new Promise((r) => waiters.push(r))),
    closed: new Promise((resolve) => ws.addEventListener("close", (e: CloseEvent) => resolve(e.code))),
  };
}

test("web host e2e: a browser client reaches a real host process, which verifies the web attestation", { timeout: 60_000 }, async () => {
  const sup = await TestSupervisor.start();
  let host: WebHost | undefined;
  try {
    await sup.waitFor("ready");
    host = await startWebHost({ config: { enabled: true, port: 0, allowedOrigins: [ORIGIN] }, mux: sup.mux, flow: sup.flow, attestationKey: sup.key, clock: { now: () => Date.now(), monotonic: () => performance.now() } });
    const token = host.takeToken();
    const a = open(host, token);
    assert.equal(await a.opened, "axis.v1");
    a.ws.send(JSON.stringify({ op: "echo", v: "hi" }));
    assert.deepEqual(await a.next(), { ok: true, echo: "hi", actor: "user", windowId: "web" });
    // A control message typed by the browser is only data for the host: the host is still up and answering.
    a.ws.send(JSON.stringify({ type: "shutdown" }));
    assert.deepEqual(await a.next(), { ok: true, unknown: true });
    a.ws.send(JSON.stringify({ op: "echo", v: 2 }));
    assert.deepEqual(await a.next(), { ok: true, echo: 2, actor: "user", windowId: "web" });
    assert.equal(sup.received.some((m) => m.type === "fatal"), false);
    // A second client works alongside; a wrong origin is refused before any connection exists.
    const b = open(host, token);
    await b.opened;
    b.ws.send(JSON.stringify({ op: "echo", v: "b" }));
    assert.deepEqual(await b.next(), { ok: true, echo: "b", actor: "user", windowId: "web" });
    const opened = sup.mux.stats().opened;
    await assert.rejects(open(host, token, "http://evil.example").opened);
    assert.equal(sup.mux.stats().opened, opened);
    a.ws.close();
    assert.equal(await a.closed, 1000);
    await host.dispose();
    assert.equal(await b.closed, 1001);
  } finally {
    await host?.dispose();
    await sup.dispose();
  }
});

test("web host e2e: with a key the host does not hold, the host refuses the connection and the browser sees 1008", { timeout: 60_000 }, async () => {
  const sup = await TestSupervisor.start();
  let host: WebHost | undefined;
  try {
    await sup.waitFor("ready");
    host = await startWebHost({ config: { enabled: true, port: 0, allowedOrigins: [ORIGIN] }, mux: sup.mux, flow: sup.flow, attestationKey: Buffer.alloc(32, 9), clock: { now: () => Date.now(), monotonic: () => performance.now() } });
    const c = open(host, host.takeToken());
    await c.opened;
    assert.equal(await c.closed, 1008, "a refused connection ends with 1008, not a normal close");
  } finally {
    await host?.dispose();
    await sup.dispose();
  }
});
