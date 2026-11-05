// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { test } from "node:test";
import { ChannelMux, ControlClient } from "../src/index.js";
import { memoryChannelPair, type MemoryEnd } from "../testing/memory-channel.js";
import { processSnapshot, trackTimers, wait } from "./helpers.js";

const chal = "C".repeat(43);
const proof = "q".repeat(32);
const head = { seq: 7, hash: "b".repeat(64) };

function setup(maxPending?: number) {
  const { a, b } = memoryChannelPair();
  const mux = new ChannelMux(a);
  const client = new ControlClient({ mux, ...(maxPending === undefined ? {} : { maxPending }) });
  const peer: Array<Record<string, unknown>> = [];
  b.onMessage((m) => peer.push(m as Record<string, unknown>));
  return { a, b, mux, client, peer };
}
const last = (peer: unknown[]): Record<string, unknown> => peer[peer.length - 1] as Record<string, unknown>;

test("anchor.get answered by id; null when the supervisor has none", async () => {
  const { b, client, peer } = setup();
  const p = client.anchorGet();
  await wait(0);
  assert.equal(last(peer)?.["type"], "anchor.get");
  b.send({ type: "anchor.result", requestId: last(peer)?.["requestId"], anchor: head });
  assert.deepEqual(await p, head);
  const q = client.anchorGet();
  await wait(0);
  b.send({ type: "anchor.result", requestId: last(peer)?.["requestId"], anchor: null });
  assert.equal(await q, null);
  assert.equal(client.stats().pending, 0);
});

test("an answer with no pending request, or for another id, is ignored and counted", async () => {
  const { b, client, peer } = setup();
  b.send({ type: "trust.result", requestId: "r999", trusted: true });
  const p = client.settingsGet("axis.cliAgents", { timeoutMs: 50 });
  await wait(0);
  const requestId = last(peer)?.["requestId"];
  b.send({ type: "settings.result", requestId, key: "axis.git.runHooks", value: false }); // other key: not the answer
  b.send({ type: "settings.result", requestId: "r888", key: "axis.cliAgents", value: [] });
  await assert.rejects(p, { code: "E_TIMEOUT" });
  assert.equal(client.stats().ignoredAnswers, 3);
  // A late answer after the timeout is ignored too.
  b.send({ type: "settings.result", requestId, key: "axis.cliAgents", value: [] });
  await wait(0);
  assert.equal(client.stats().ignoredAnswers, 4);
});

test("settings.get returns the value main sent", async () => {
  const { b, client, peer } = setup();
  const p = client.settingsGet("axis.git.runHooks");
  await wait(0);
  b.send({ type: "settings.result", requestId: last(peer)?.["requestId"], key: "axis.git.runHooks", value: true });
  assert.equal(await p, true);
});

test("trust.check: trusted resolves; untrusted, no answer and a closed channel all refuse with E_POLICY_DENIED", async () => {
  const { b, client, peer } = setup();
  const req = { windowId: "win-1", workspaceId: "ws-1", projectId: "p-1" };
  const ok = client.trustCheck(req);
  await wait(0);
  assert.deepEqual({ ...last(peer), requestId: undefined }, { type: "trust.check", requestId: undefined, ...req });
  b.send({ type: "trust.result", requestId: last(peer)?.["requestId"], trusted: true });
  await ok;

  const no = client.trustCheck(req);
  await wait(0);
  b.send({ type: "trust.result", requestId: last(peer)?.["requestId"], trusted: false });
  await assert.rejects(no, { code: "E_POLICY_DENIED", detail: { reason: "untrusted" } });

  await assert.rejects(client.trustCheck(req, { timeoutMs: 20 }), { code: "E_POLICY_DENIED", detail: { reason: "untrusted" } });

  const ac = new AbortController();
  const cancelled = client.trustCheck(req, { signal: ac.signal });
  ac.abort();
  await assert.rejects(cancelled, { code: "E_CANCELLED" });

  b.close();
  await wait(0);
  await assert.rejects(client.trustCheck(req), { code: "E_POLICY_DENIED" });
});

test("native.confirm: matched by challenge id, answer carries the proof back, error text carries no secret", async () => {
  const { b, client, peer } = setup();
  const req = { challengeId: chal, proof, windowId: "win-1", summary: "Push axis/x" };
  const p = client.nativeConfirm(req);
  await wait(0);
  assert.deepEqual(last(peer), { type: "native.confirm", ...req });
  await assert.rejects(client.nativeConfirm(req), (e: Error & { code?: string }) => e.code === "E_CONFLICT" && !e.message.includes(chal));
  b.send({ type: "native.result", challengeId: "D".repeat(43), proof, confirmed: true, windowId: "win-1" });
  b.send({ type: "native.result", challengeId: chal, proof, confirmed: true, windowId: "win-1" });
  assert.deepEqual(await p, { confirmed: true, proof, windowId: "win-1" });
  assert.equal(client.stats().ignoredAnswers, 1);

  const slow = client.nativeConfirm({ ...req, challengeId: "E".repeat(43) }, { timeoutMs: 10 });
  await assert.rejects(slow, (e: Error & { code?: string; detail?: unknown }) => {
    const text = JSON.stringify([e.message, e.detail]);
    return e.code === "E_TIMEOUT" && !text.includes(proof) && !text.includes("E".repeat(43));
  });
});

test("cancellation before sending sends nothing; pending requests are bounded", async () => {
  const { client, peer } = setup(2);
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(client.anchorGet({ signal: ac.signal }), { code: "E_CANCELLED" });
  const p1 = client.anchorGet({ timeoutMs: 30 });
  const p2 = client.anchorGet({ timeoutMs: 30 });
  await assert.rejects(client.anchorGet(), { code: "E_BACKPRESSURE" });
  await Promise.allSettled([p1, p2]);
  assert.equal(peer.filter((m) => m["type"] === "anchor.get").length, 2);
  await assert.rejects(client.anchorGet({ timeoutMs: 0 }), { code: "E_INVALID_ARGUMENT" });
});

test("inbound events: init once, connect, trust.set, projects.register, shutdown, anchor.ack; invalid are counted", async () => {
  const { b, client } = setup();
  const seen: string[] = [];
  client.onInit((c) => seen.push(`init:${Object.keys(c).join(",")}`));
  client.onConnect((c) => seen.push(`connect:${c.cid}`));
  client.onTrustSet((m) => seen.push(`trust:${String(m.trusted)}`));
  client.onProjectsRegister((m) => seen.push(`project:${m.path}`));
  client.onShutdown(() => seen.push("shutdown"));
  client.onAnchorAck((s) => seen.push(`ack:${s}`));
  const att = { identity: { actor: "user" }, issuedAt: 1, mac: "m".repeat(43) };
  b.send({ type: "init", config: { dataDir: "/d" } });
  b.send({ type: "init", config: { dataDir: "/other" } });
  b.send({ type: "connect", cid: "conn-0001", attestation: att });
  b.send({ type: "trust.set", windowId: "w", trusted: true });
  b.send({ type: "projects.register", requestId: "r1", path: "/p", trusted: false });
  b.send({ type: "anchor.ack", seq: 4 });
  b.send({ type: "shutdown" });
  b.send({ type: "shutdown", extra: 1 });
  b.send({ type: "mystery" });
  await wait(0);
  assert.deepEqual(seen, ["init:dataDir", "connect:conn-0001", "trust:true", "project:/p", "ack:4", "shutdown"]);
  assert.equal(client.stats().duplicateInits, 1);
  assert.equal(client.stats().invalidMessages, 2);
});

test("a handler that throws does not stop the others", async () => {
  const { b, client } = setup();
  let n = 0;
  client.onShutdown(() => {
    throw new Error("x");
  });
  client.onShutdown(() => n++);
  b.send({ type: "shutdown" });
  await wait(0);
  assert.equal(n, 1);
});

test("outbound messages are validated before they are sent, with fixed error text", () => {
  const { client } = setup();
  assert.throws(() => client.send({ type: "fatal", code: "E_NOPE" } as never), (e: Error & { code?: string }) => e.code === "E_INVALID_ARGUMENT" && !e.message.includes("E_NOPE"));
  assert.throws(() => client.anchorPut({ seq: 0, hash: "z" }), { code: "E_INVALID_ARGUMENT" });
});

test("dispose rejects what is waiting and leaves no timer, listener or pending entry", async () => {
  const before = processSnapshot();
  const { a, client, mux } = setup();
  const waiting = [client.anchorGet(), client.settingsGet("axis.cliAgents"), client.trustCheck({ windowId: "w", workspaceId: "s", projectId: "p" })];
  const ac = new AbortController();
  const withSignal = client.anchorGet({ signal: ac.signal });
  client.dispose();
  client.dispose();
  const results = await Promise.allSettled([...waiting, withSignal]);
  assert.deepEqual(results.map((r) => r.status), ["rejected", "rejected", "rejected", "rejected"]);
  assert.equal(client.stats().pending, 0);
  await assert.rejects(client.anchorGet(), { code: "E_UNAVAILABLE" });
  assert.throws(() => client.send({ type: "fatal", code: "E_INTERNAL" }), { code: "E_UNAVAILABLE" });
  mux.dispose();
  assert.equal((a as MemoryEnd).listeners(), 0);
  await wait(5);
  assert.deepEqual(processSnapshot(), before);
});

test("the channel closing rejects waiting requests with E_UNAVAILABLE", async () => {
  const { b, client } = setup();
  const p = client.anchorGet();
  b.close();
  await assert.rejects(p, { code: "E_UNAVAILABLE" });
  assert.equal(client.stats().pending, 0);
});

test("every way a request can end clears its timer and abort listener at once", async () => {
  const timers = trackTimers();
  try {
    const { b, client, peer } = setup();
    const ac = new AbortController();
    // answered
    const watched = new AbortController();
    const answered = client.anchorGet({ signal: watched.signal });
    await wait(0);
    assert.equal(getEventListeners(watched.signal, "abort").length, 1);
    b.send({ type: "anchor.result", requestId: last(peer)?.["requestId"], anchor: null });
    await answered;
    assert.equal(getEventListeners(watched.signal, "abort").length, 0);
    // cancelled
    const cancelled = client.anchorGet({ signal: ac.signal });
    ac.abort();
    await assert.rejects(cancelled, { code: "E_CANCELLED" });
    // timed out
    await assert.rejects(client.anchorGet({ timeoutMs: 5 }), { code: "E_TIMEOUT" });
    // channel closed
    const closed = client.anchorGet();
    b.close();
    await assert.rejects(closed, { code: "E_UNAVAILABLE" });
    assert.equal(timers.live(), 0);
  } finally {
    timers.restore();
  }
});

test("native.confirm ignores an answer for another window or with another proof", async () => {
  const { b, client, peer } = setup();
  const req = { challengeId: chal, proof, windowId: "win-1", summary: "Push" };
  const p = client.nativeConfirm(req, { timeoutMs: 100 });
  await wait(0);
  assert.equal(last(peer)?.["type"], "native.confirm");
  b.send({ type: "native.result", challengeId: chal, proof, confirmed: true, windowId: "win-2" });
  b.send({ type: "native.result", challengeId: chal, proof: "x".repeat(32), confirmed: true, windowId: "win-1" });
  await assert.rejects(p, { code: "E_TIMEOUT" });
  assert.equal(client.stats().ignoredAnswers, 2);
});
