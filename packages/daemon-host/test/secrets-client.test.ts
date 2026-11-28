// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// PV-N0c-1 (docs/design/secret-broker.md §3.4): the control client's `secrets.*` request on its own: the default budgets per
// op (65 s for get and put, 10 s for the rest), and an answer of another op refused at once.
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { ChannelMux, ControlClient } from "../src/index.js";
import { memoryChannelPair } from "../testing/memory-channel.js";
import { wait } from "./helpers.js";

/** One turn of the event loop that the mocked setTimeout does not hold back. */
const turn = (): Promise<void> => new Promise((r) => setImmediate(r));

function setup() {
  const { a, b } = memoryChannelPair();
  const client = new ControlClient({ mux: new ChannelMux(a) });
  const seen: Array<{ type: string; requestId: string }> = [];
  b.onMessage((m) => void seen.push(m as { type: string; requestId: string }));
  return { b, client, seen };
}

test("with no timeout given, get and put wait 65 s and the other requests 10 s", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { client } = setup();
  const outcome = (p: Promise<unknown>) => {
    const box: { v?: string } = {};
    p.then(
      () => (box.v = "resolved"),
      (e: { code?: string }) => (box.v = e.code ?? "rejected"),
    );
    return box;
  };
  const get = outcome(client.secrets({ type: "secrets.get", name: "c1" }));
  const put = outcome(client.secrets({ type: "secrets.put", name: "c2", secret: "test-credential-value-0001", meta: { storedAt: 1, backend: "gnome_libsecret", protection: "os_protected", weakConsent: false } }));
  const meta = outcome(client.secrets({ type: "secrets.meta", name: "c3" }));
  const list = outcome(client.secrets({ type: "secrets.list" }));
  t.mock.timers.tick(9_999);
  await turn();
  assert.deepEqual([get.v, put.v, meta.v, list.v], [undefined, undefined, undefined, undefined]);
  t.mock.timers.tick(1);
  await turn();
  assert.deepEqual([get.v, put.v, meta.v, list.v], [undefined, undefined, "E_TIMEOUT", "E_TIMEOUT"]);
  t.mock.timers.tick(54_999);
  await turn();
  assert.deepEqual([get.v, put.v], [undefined, undefined]);
  t.mock.timers.tick(1);
  await turn();
  assert.deepEqual([get.v, put.v], ["E_TIMEOUT", "E_TIMEOUT"]);
  assert.equal(client.stats().pending, 0);
  mock.timers.reset();
});

test("the client itself refuses an answer of another op, at once", async () => {
  const { b, client, seen } = setup();
  const p = client.secrets({ type: "secrets.get", name: "c1" }, { timeoutMs: 60_000 });
  const refused = assert.rejects(p, (e: { code?: string; detail?: Record<string, unknown> }) => e.code === "E_INTERNAL" && e.detail?.["reason"] === "answer_invalid");
  await wait(0);
  b.send({ type: "secrets.result", requestId: seen[0]?.requestId, ok: true, value: { op: "remove", removed: true } });
  await refused;
  assert.equal(client.stats().pending, 0);
});

test("every rejection says whether the request left the daemon: busy and closed-before-send did not, a sent one cut off by dispose did", async () => {
  const { client } = setup();
  const sentOf = async (p: Promise<unknown>): Promise<unknown> => p.then(() => "resolved", (e: { detail?: Record<string, unknown> }) => e.detail?.["sent"]);
  const held = Array.from({ length: 8 }, (_, i) => client.secrets({ type: "secrets.meta", name: `c${i}` }, { timeoutMs: 60_000 }));
  const results = held.map(sentOf);
  assert.equal(await sentOf(client.secrets({ type: "secrets.meta", name: "c9" })), false, "the ninth was never sent");
  await wait(0);
  client.dispose();
  for (const r of await Promise.all(results)) assert.equal(r, true, "sent, then cut off by dispose");
  assert.equal(await sentOf(client.secrets({ type: "secrets.meta", name: "c1" })), false, "after dispose nothing is sent");
});
