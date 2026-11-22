// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { TestContext } from "node:test";
import { test } from "node:test";
import { relayInbound, relayOutbound } from "@axis/pty-process";
import { MAX_HOP } from "@axis/protocol";
import { ENDPOINT_LIMITS, WITHHELD_BODY, createMessagingBinding, endpointIdOf, hostMessagingDeps, type MessageCaller, type RelayOut } from "../src/index.js";
import { deliveryRig, type DeliveryRig } from "./messages-delivery-rig.js";

// PV-M6 slice 1: the daemon's side of the CLI messaging endpoint, driven by a fake relay (no listener). ADR 0007 decision 7 and
// validation lines 2, 3, 5, 6 and 7; endpoint design section 7 lines 2, 4, 5 and 6 on the daemon side.

const a2 = (receivedHop = 0): MessageCaller => ({ kind: "agent", agentId: "a2", runId: null, verified: true, receivedHop });

interface Fx {
  readonly r: DeliveryRig;
  readonly runId: string;
  readonly ep: string;
  readonly token: string;
  open(conn: string): Promise<readonly RelayOut[]>;
  frame(conn: string, body: unknown): Promise<readonly RelayOut[]>;
  /** Open, authenticate and return the connection id. */
  authed(conn?: string): Promise<string>;
}

async function fx(t: TestContext, o: Parameters<typeof deliveryRig>[1] = {}): Promise<Fx> {
  const r = await deliveryRig(t, { noDelivery: true, ...o });
  r.c.journal.messages.setAgentSettings("c1", { acceptsFrom: "group", cliMessaging: true, muted: false });
  const runId = r.run("c1");
  const minted = r.m.endpoints.relay.mint(runId);
  assert.ok(minted !== undefined, "minted for a live run of a known CLI agent with messaging on");
  const src = r.m.endpoints.source;
  const relay = r.m.endpoints.relay;
  const f: Fx = {
    r,
    runId,
    ep: minted.endpointId,
    token: minted.token,
    open: (conn) => relay.onRelay(src, { t: "relay-open", endpoint: minted.endpointId, conn }),
    frame: (conn, body) => relay.onRelay(src, { t: "relay-frame", endpoint: minted.endpointId, conn, frame: typeof body === "string" ? body : JSON.stringify(body) }),
    async authed(conn = "c-1") {
      await f.open(conn);
      const [out] = await f.frame(conn, { op: "auth", token: minted.token });
      assert.deepEqual(json(out), { ok: true, op: "auth" });
      return conn;
    },
  };
  return f;
}
/** The reply frame's JSON, checked against the shared envelope schema first. */
function json(out: RelayOut | undefined): Record<string, unknown> {
  assert.ok(out !== undefined && out.t === "relay-reply", JSON.stringify(out));
  relayOutbound.parse(out);
  return JSON.parse(out.frame) as Record<string, unknown>;
}
const rows = (r: DeliveryRig) => r.c.audit.list({ limit: 5000 }).filter((e) => e.action === "message.endpoint").map((e) => e.payload as Record<string, unknown>);
const send = (to: string, body: string, over: Record<string, unknown> = {}) => ({ op: "send", id: "s1", recipients: [{ agent: to }], body, ...over });

test("inert in production: the host's binding mints no endpoint; nor for a composer agent, messaging off, Windows, a dead run or twice", async (t) => {
  assert.equal("agentOf" in hostMessagingDeps({ journal: { messages: {} as never, getProject: () => undefined, getRun: () => undefined }, audit: { append: () => undefined }, monotonic: () => 0, scan: async () => [], logger: undefined, holdsSecret: () => false }), false);
  const r = await deliveryRig(t, { noDelivery: true });
  const prod = createMessagingBinding({ journal: r.c.journal, audit: r.c.audit, random: { bytes: (n) => randomBytes(n) }, monotonic: () => 0, scan: async () => [], holdsSecret: () => false, directory: { project: () => true, agent: (id) => ({ agentId: id, projectId: "p", groupId: null, kind: "cli" }), group: () => undefined, agents: () => [] }, runLive: () => true, platform: "linux" });
  assert.equal(prod.endpoints.relay.mint(r.run("c1")), undefined, "no agentOf: no run has an agent");
  assert.equal(r.m.endpoints.relay.mint(r.run("c1")), undefined, "messaging is off for c1 (the default)");
  r.c.journal.messages.setAgentSettings("c1", { acceptsFrom: "group", cliMessaging: true, muted: false });
  r.c.journal.messages.setAgentSettings("a1", { acceptsFrom: "group", cliMessaging: true, muted: false });
  assert.equal(r.m.endpoints.relay.mint(r.run("a1")), undefined, "a composer agent gets no endpoint, even with the setting on");
  const win = createMessagingBinding({ journal: r.c.journal, audit: r.c.audit, random: { bytes: (n) => randomBytes(n) }, monotonic: () => 0, scan: async () => [], holdsSecret: () => false, directory: { project: () => true, agent: (id) => ({ agentId: id, projectId: "p", groupId: null, kind: "cli" }), group: () => undefined, agents: () => [] }, agentOf: () => "c1", runLive: () => true, platform: "win32" });
  assert.equal(win.endpoints.relay.mint(r.run("c1")), undefined, "ADR 0007 validation 3: no endpoint on Windows without the pipe helper");
  const dead = r.run("c1");
  r.c.journal.transitionRun(dead, "FAILED");
  assert.equal(r.m.endpoints.relay.mint(dead), undefined, "a run that is not RUNNING");
  const live = r.run("c1");
  const once = r.m.endpoints.relay.mint(live);
  assert.ok(once !== undefined && once.endpointId === endpointIdOf(live) && /^[A-Za-z0-9_-]{43}$/.test(once.token));
  assert.equal(r.m.endpoints.relay.mint(live), undefined, "one endpoint per run");
});

test("ADR 0007 validation 2: a wrong token is refused (backoff signalled, connection closed); the caller is never taken from a frame", async (t) => {
  const f = await fx(t);
  await f.open("c-1");
  const [bad] = await f.frame("c-1", { op: "auth", token: "A".repeat(43) });
  assert.deepEqual([json(bad), bad?.t === "relay-reply" && bad.close, bad?.t === "relay-reply" && bad.authFailed], [{ ok: false, reason: "bad_token" }, true, true]);
  // An invalid frame closes its connection: each forged frame gets a fresh, authenticated one.
  for (const [i, forged] of [{ sender: { kind: "user" } }, { agentId: "a2" }, { runId: "x" }, { verified: true }, { hop: 0 }, { projectId: "q" }].entries()) {
    const [out] = await f.frame(await f.authed(`fg${i}`), send("a1", "forged", forged));
    assert.deepEqual(json(out), { ok: false, reason: "invalid" }, JSON.stringify(forged));
  }
  const ok = json((await f.frame(await f.authed("c-ok"), send("a1", "hello from the cli")))[0]);
  assert.equal(ok["ok"], true);
  const got = f.r.m.service.read({ kind: "agent", agentId: "a1", runId: null, verified: true, receivedHop: 0 }, {}).messages;
  assert.deepEqual(got.map((m) => [m.sender, m.body.text]), [[{ kind: "agent", agentId: "c1", runId: f.runId, verified: false }, "hello from the cli"]], "the binding's caller, unverified");
});

test("ADR 0007 validation 7: relay hardening, each refused by the daemon", async (t) => {
  const f = await fx(t);
  const relay = f.r.m.endpoints.relay;
  assert.deepEqual(await relay.onRelay(Symbol("pty-control"), { t: "relay-open", endpoint: f.ep, conn: "x" }), [], "another channel: ignored");
  assert.deepEqual(json((await f.frame("x", { op: "auth", token: f.token }))[0]), { ok: false, reason: "refused" }, "and it opened nothing");
  assert.deepEqual(json((await f.frame("never-opened", { op: "auth", token: f.token }))[0]), { ok: false, reason: "refused" }, "a connection that was not opened");
  const closed = await f.authed("c-closed");
  await relay.onRelay(f.r.m.endpoints.source, { t: "relay-close", endpoint: f.ep, conn: closed });
  assert.deepEqual(json((await f.frame(closed, send("a1", "x")))[0]), { ok: false, reason: "refused" }, "a closed connection");
  await f.open("c-twice");
  await f.frame("c-twice", { op: "auth", token: "B".repeat(43) });
  assert.deepEqual(json((await f.frame("c-twice", { op: "auth", token: f.token }))[0]), { ok: false, reason: "refused" }, "a second auth after a failed one");
  await f.open("c-failed");
  await f.frame("c-failed", { op: "auth", token: "B".repeat(43) });
  assert.deepEqual(json((await f.frame("c-failed", { op: "read", id: "r" }))[0]), { ok: false, reason: "refused" }, "nor any request on a connection whose auth failed");
  const authed = await f.authed("c-again");
  assert.deepEqual(json((await f.frame(authed, { op: "auth", token: f.token }))[0]), { ok: false, reason: "refused" }, "a second auth on an authenticated connection");
  const other = endpointIdOf("run-not-minted");
  assert.deepEqual(json((await relay.onRelay(f.r.m.endpoints.source, { t: "relay-frame", endpoint: other, conn: "c", frame: "{}" }))[0]), { ok: false, reason: "refused" }, "an endpoint id the daemon did not mint");
  await f.open("c-first");
  assert.deepEqual(json((await f.frame("c-first", { op: "read", id: "r" }))[0]), { ok: false, reason: "unauthenticated" }, "the first frame must be auth");
  for (const bad of ["{", "[".repeat(40) + "]".repeat(40), JSON.stringify({ op: "auth", token: f.token, extra: 1 }), "x".repeat(ENDPOINT_LIMITS.frameChars + 1)]) {
    await f.open("c-bad");
    assert.deepEqual(json((await f.frame("c-bad", bad))[0]), { ok: false, reason: "invalid" });
  }
  for (const c of ["k1", "k2", "k3", "k4"]) await f.open(c);
  assert.deepEqual(json((await f.open("k5"))[0]), { ok: false, reason: "refused" }, "a fifth connection");
});

test("ADR 0007 validation 7: a fifth relay in flight for one endpoint is refused busy; the four complete", async (t) => {
  const gates: (() => void)[] = [];
  const f = await fx(t, { scan: () => new Promise((res) => gates.push(() => res([]))) });
  const conns = [await f.authed("b1"), await f.authed("b2"), await f.authed("b3"), await f.authed("b4")];
  const pending = conns.map((c) => f.frame(c, send("a1", `msg ${c}`)));
  await new Promise((res) => setImmediate(res));
  await f.r.m.endpoints.relay.onRelay(f.r.m.endpoints.source, { t: "relay-close", endpoint: f.ep, conn: "b4" });
  await f.open("b5");
  await f.frame("b5", { op: "auth", token: f.token });
  // Released before the fifth is awaited, so a relay that let it through answers at once instead of hanging the test.
  const fifth = f.frame("b5", send("a1", "fifth"));
  await new Promise((res) => setImmediate(res));
  gates.forEach((g) => g());
  await new Promise((res) => setImmediate(res));
  gates.forEach((g) => g());
  assert.deepEqual(json((await fifth)[0]), { id: "s1", ok: false, reason: "busy" });
  for (const p of pending) assert.equal(json((await p)[0])["ok"], true);
});

test("ADR 0007 validation 6 and endpoint line 2: once the run leaves RUNNING, an open connection and the old token are refused", async (t) => {
  const f = await fx(t);
  const conn = await f.authed();
  f.r.c.journal.transitionRun(f.runId, "FAILED");
  const out = await f.frame(conn, send("a1", "after the end"));
  assert.deepEqual(out[0], { t: "endpoint-close", endpoint: f.ep, reason: "revoked" });
  assert.deepEqual(json(out[1]), { ok: false, reason: "revoked" });
  await f.open("c-new");
  assert.deepEqual(json((await f.frame("c-new", { op: "auth", token: f.token }))[0]), { ok: false, reason: "revoked" });
  assert.deepEqual(rows(f.r).map((p) => p["event"]), ["minted", "revoked"]);
  assert.deepEqual(f.r.m.endpoints.relay.revoke(f.runId), { t: "endpoint-close", endpoint: f.ep, reason: "revoked" });
});

test("endpoint line 2: Pause of the agent's scope makes an open connection answer paused", async (t) => {
  const f = await fx(t);
  const conn = await f.authed();
  f.r.m.settings.pause({ kind: "user" }, { scope: { project: "p" } });
  assert.deepEqual(json((await f.frame(conn, { op: "read", id: "r1" }))[0]), { ok: false, reason: "paused" });
});

test("ADR 0007 validation 5: a composer message at hop h read through the endpoint, relayed into a new thread, carries h + 1; it stops at 8", async (t) => {
  const f = await fx(t);
  await f.r.m.service.send(a2(3), { recipients: [{ agent: "c1" }], body: { format: "text", text: "relay this" } });
  const conn = await f.authed();
  const read = json((await f.frame(conn, { op: "read", id: "r1" }))[0]);
  assert.deepEqual((read["messages"] as { hop: number }[]).map((m) => m.hop), [4]);
  const sent = json((await f.frame(conn, send("a1", "relayed")))[0]);
  assert.equal(sent["hop"], 5, "the run's received hop 4, plus one");
  await f.r.m.service.send(a2(MAX_HOP - 1), { recipients: [{ agent: "c1" }], body: { format: "text", text: "at the cap" } });
  json((await f.frame(conn, { op: "read", id: "r2" }))[0]);
  assert.deepEqual(json((await f.frame(conn, send("a1", "too far")))[0]), { id: "s1", ok: false, reason: "hop_limit" });
  json((await f.frame(conn, { op: "read", id: "r3", threadId: (read["messages"] as { threadId: string }[])[0]?.threadId }))[0]);
  assert.deepEqual(json((await f.frame(conn, send("a1", "still too far")))[0])["reason"], "hop_limit", "never lowered by a read of a lower hop");
});

test("endpoint line 5: escape sequences and a bidi override come back escaped; a body holding a secret is withheld", async (t) => {
  const f = await fx(t);
  f.r.c.redactor.registerSecret("plum orchard quietly");
  await f.r.m.service.send(a2(), { recipients: [{ agent: "c1" }], body: { format: "text", text: "\u001b]52;c;Y2xpcA==\u0007 \u001b]8;;http://x\u0007link\u001b]8;;\u0007 ‮evil" } });
  await f.r.m.service.send(a2(), { recipients: [{ agent: "c1" }], body: { format: "text", text: "key plum orchard quietly" } });
  const out = (await f.frame(await f.authed(), { op: "read", id: "r1" }))[0];
  assert.ok(out?.t === "relay-reply" && !/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‮]/.test(out.frame) && !out.frame.includes("\\u001b"), "no raw control or bidi character, even JSON-escaped");
  const bodies = (json(out)["messages"] as { body: string; sender: { verified: boolean } }[]).map((m) => m.body);
  assert.ok(bodies[0]?.includes("\\u{1b}]52;c;") && bodies[0].includes("\\u{1b}]8;;") && bodies[0].includes("\\u{202e}evil"));
  assert.equal(bodies[1], WITHHELD_BODY);
});

test("endpoint line 4: reads are limited to 60 a minute per endpoint", async (t) => {
  const f = await fx(t, { limits: { readsPerMinute: 1_000 } });
  const conn = await f.authed();
  const reasons: unknown[] = [];
  for (let i = 0; i < 61; i++) reasons.push(json((await f.frame(conn, { op: "read", id: `r${i}` }))[0])["reason"]);
  assert.deepEqual([reasons.slice(0, 60).every((x) => x === undefined), reasons[60]], [true, "rate_limited"]);
  f.r.c.r.clock.advance(60_000);
  assert.equal(json((await f.frame(conn, { op: "read", id: "again" }))[0])["ok"], true);
});

test("endpoint lines 4 and 6: 1,000 bad tokens make one aggregated audit row a minute, and the token is nowhere in the audit log or the journal", async (t) => {
  const f = await fx(t);
  const relay = f.r.m.endpoints.relay;
  for (let i = 0; i < 1_000; i++) {
    await f.open(`x${i}`);
    await f.frame(`x${i}`, { op: "auth", token: "C".repeat(43) });
    await relay.onRelay(f.r.m.endpoints.source, { t: "relay-close", endpoint: f.ep, conn: `x${i}` });
  }
  assert.deepEqual(rows(f.r).map((p) => p["event"]), ["minted"], "nothing per attempt");
  f.r.c.r.clock.advance(61_000);
  await f.open("late");
  await f.frame("late", { op: "auth", token: "D".repeat(43) });
  relay.flush();
  assert.deepEqual(rows(f.r).filter((p) => p["event"] === "auth_failed").map((p) => p["failures"]), [1_000, 1]);
  await f.frame(await f.authed("good"), send("a1", "a message"));
  relay.revoke(f.runId);
  const tables = (f.r.c.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((x) => x.name);
  const dump = tables.map((n) => JSON.stringify(f.r.c.db.prepare(`SELECT * FROM "${n}"`).all())).join("\n");
  assert.ok(!dump.includes(f.token), "the token appears nowhere in the journal or the audit log (canary)");
});

test("the relay envelope: the daemon's replies pass the shared schema, and the shared inbound schema bounds a frame", () => {
  assert.equal(relayInbound.safeParse({ t: "relay-frame", endpoint: endpointIdOf("r"), conn: "c", frame: "x".repeat(ENDPOINT_LIMITS.frameChars + 1) }).success, false);
  assert.equal(relayInbound.safeParse({ t: "relay-frame", endpoint: "ep_bad id", conn: "c", frame: "{}" }).success, false);
  assert.equal(relayInbound.safeParse({ t: "relay-open", endpoint: endpointIdOf("r"), conn: "C", extra: 1 }).success, false);
  assert.equal(relayOutbound.safeParse({ t: "endpoint-close", endpoint: endpointIdOf("r"), reason: "revoked" }).success, true);
});
