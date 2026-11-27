// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createPtyProcessPort, createPtyService, type Channel, type PtyChild, type PtyExit, type SpawnRequest } from "@axis/pty-process";
import { cliEndpointPty, createMessagingSettings, wireCliEndpoints, type CliEndpoints, type PtyHandle, type PtyPort, type RelayIn, type RelayOut } from "../src/index.js";
import { deliveryRig } from "./messages-delivery-rig.js";

// PV-M6 slice 2, daemon side: the messaging options (both off by default), the spawn that mints and hands over a CLI run's
// endpoint, and the whole chain over a real socket: shim -> pty process listener -> control channel -> daemon relay -> service.
// Its rig creates a RUNNING run before spawning; the run lifecycle through the REAL supervisor (spawn while QUEUED, RUNNING
// after) is `messages-endpoint-lifecycle.test.ts`, which a change to mint or to the run-state checks must keep passing.

const posix = process.platform !== "win32";
const skip = posix ? undefined : "Unix sockets: Windows has no messaging endpoint until the native pipe helper exists";
const SPEC = { runId: "r1", argv: ["/bin/true"], cwd: "/work", env: { PATH: "/usr/bin" }, cols: 80, rows: 24 } as const;

function fakeHandle(): PtyHandle & { exit(): void } {
  const exits: ((e: PtyExit) => void)[] = [];
  return { kill: () => undefined, groupAlive: () => false, onExit: (l: (e: PtyExit) => void) => (exits.push(l), { dispose: () => undefined }), exit: () => exits.forEach((l) => l({ exitCode: 0, signal: null })) } as unknown as PtyHandle & { exit(): void };
}

test("the endpoint relay is wired only when the user's switch is on at start, and only to a pty port that relays", () => {
  const relay = { onRelay: async () => [], mint: () => undefined, revoke: () => undefined, revokeWorker: () => [], dropPaused: () => [], flush: () => undefined };
  const endpoints = { relay, source: Symbol("pty-control") };
  const port = { onRelay: () => ({ dispose: () => undefined }), relay: () => true };
  assert.equal(wireCliEndpoints(false, port, endpoints, []), undefined, "the switch off");
  assert.equal(wireCliEndpoints(true, {}, endpoints, []), undefined, "a pty port without the relay");
  assert.ok(wireCliEndpoints(true, port, endpoints, []) !== undefined);
});

test("the wired relay: relayed messages reach the daemon's relay with the channel's mark, answers go back, shutdown flushes", async () => {
  const seen: [symbol, RelayIn][] = [];
  const sent: RelayOut[] = [];
  let flushed = 0;
  let handler: ((m: RelayIn) => void) | undefined;
  const source = Symbol("pty-control");
  const relay = {
    onRelay: async (s: symbol, m: RelayIn): Promise<readonly RelayOut[]> => (seen.push([s, m]), [{ t: "endpoint-close", endpoint: m.endpoint, reason: "revoked" }]),
    mint: () => ({ endpointId: "ep_x", token: "t" }),
    revoke: (runId: string): RelayOut => ({ t: "endpoint-close", endpoint: `ep_${runId}`, reason: "revoked" }),
    flush: () => void flushed++,
  };
  const cleanups: (() => void)[] = [];
  const wired = wireCliEndpoints(true, { onRelay: (h: (m: RelayIn) => void) => ((handler = h), { dispose: () => (handler = undefined) }), relay: (m: RelayOut) => (sent.push(m), true) }, { relay: relay as never, source }, cleanups) as CliEndpoints;
  handler?.({ t: "relay-open", endpoint: "ep_a", conn: "c0" });
  await new Promise((res) => setImmediate(res));
  assert.deepEqual(seen, [[source, { t: "relay-open", endpoint: "ep_a", conn: "c0" }]]);
  assert.deepEqual(sent, [{ t: "endpoint-close", endpoint: "ep_a", reason: "revoked" }]);
  wired.revoke("r9");
  assert.deepEqual(sent.at(-1), { t: "endpoint-close", endpoint: "ep_r9", reason: "revoked" }, "a revocation closes the endpoint at once");
  cleanups.forEach((c) => c());
  assert.equal(flushed, 1);
  assert.equal(handler, undefined);
});

test("the CLI run spawn: no endpoints, the spec is untouched; with one, it is minted and handed over, and revoked at exit or on a failed spawn", async () => {
  const specs: unknown[] = [];
  const handle = fakeHandle();
  let fail = false;
  const inner: PtyPort = { spawn: async (s) => (specs.push(s), fail ? Promise.reject(new Error("no")) : handle) };
  await cliEndpointPty(inner, () => undefined).spawn(SPEC);
  assert.deepEqual(specs[0], SPEC, "the default: nothing added");
  const revoked: string[] = [];
  const e: CliEndpoints = { mint: (id) => (id === "r1" ? { endpointId: "ep_r1", token: "tok" } : undefined), revoke: (id) => void revoked.push(id) };
  await cliEndpointPty(inner, () => e).spawn({ ...SPEC, runId: "other" });
  assert.equal("messagesEndpoint" in (specs[1] as object), false, "a run with no endpoint (not minted)");
  await cliEndpointPty(inner, () => e).spawn(SPEC);
  assert.deepEqual((specs[2] as { messagesEndpoint?: unknown }).messagesEndpoint, { endpoint: "ep_r1", token: "tok" });
  assert.deepEqual(revoked, []);
  handle.exit();
  assert.deepEqual(revoked, ["r1"], "revoked when the run's process exits");
  fail = true;
  await assert.rejects(cliEndpointPty(inner, () => e).spawn(SPEC));
  assert.deepEqual(revoked, ["r1", "r1"], "and when the spawn fails");
});

/** An in-memory control channel pair (each message cloned, delivered on a later tick, like a port). */
function pair(): [Channel, Channel] {
  const make = (): { ch: Channel; deliver: (m: unknown) => void; closeIt: () => void } => {
    const ls: ((m: unknown) => void)[] = [];
    const cs: (() => void)[] = [];
    return { ch: { send: () => undefined, onMessage: (l) => (ls.push(l), { dispose: () => undefined }), onClose: (l) => (cs.push(l), { dispose: () => undefined }), close: () => cs.forEach((c) => c()) }, deliver: (m) => ls.forEach((l) => l(structuredClone(m))), closeIt: () => cs.forEach((c) => c()) };
  };
  const a = make();
  const b = make();
  (a.ch as { send: (m: unknown) => void }).send = (m) => void setImmediate(() => b.deliver(m));
  (b.ch as { send: (m: unknown) => void }).send = (m) => void setImmediate(() => a.deliver(m));
  return [a.ch, b.ch];
}
function child(): PtyChild & { end(): void } {
  const exits: ((e: PtyExit) => void)[] = [];
  return { pid: 4242, group: { kind: "job" }, write: () => undefined, resize: () => undefined, kill: () => undefined, onData: () => ({ dispose: () => undefined }), onExit: (l: (e: PtyExit) => void) => (exits.push(l), { dispose: () => undefined }), end: () => exits.forEach((l) => l({ exitCode: 0, signal: null })) } as unknown as PtyChild & { end(): void };
}
const frame = (o: unknown): Buffer => {
  const b = Buffer.from(JSON.stringify(o), "utf8");
  const h = Buffer.alloc(4);
  h.writeUInt32BE(b.length, 0);
  return Buffer.concat([h, b]);
};
async function call(s: Socket, o: unknown): Promise<Record<string, unknown>> {
  const got = new Promise<Buffer>((res) => {
    let buf = Buffer.alloc(0);
    const on = (d: Buffer): void => {
      buf = Buffer.concat([buf, d]);
      if (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
        s.off("data", on);
        res(buf.subarray(4, 4 + buf.readUInt32BE(0)));
      }
    };
    s.on("data", on);
  });
  s.write(frame(o));
  return JSON.parse((await got).toString("utf8")) as Record<string, unknown>;
}

test("end to end over a real socket: a CLI run's endpoint relays auth, send and read through the daemon, and goes with the run", { skip }, async (t: TestContext) => {
  const r = await deliveryRig(t, { noDelivery: true });
  r.c.journal.messages.setAgentSettings("c1", { acceptsFrom: "group", cliMessaging: true, muted: false });
  const base = mkdtempSync(join(tmpdir(), "axep-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const [daemonSide, ptySide] = pair();
  const children: (PtyChild & { end(): void })[] = [];
  const requests: SpawnRequest[] = [];
  const service = createPtyService({ spawn: (req) => (requests.push(req), children.push(child()), children.at(-1) as PtyChild), messagesEndpoints: { dir: join(base, "d"), platform: process.platform, uid: process.getuid?.() ?? -1 } });
  t.after(() => service.dispose());
  service.serveControl(ptySide);
  let port: ReturnType<typeof createPtyProcessPort> | undefined;
  port = createPtyProcessPort({ channel: daemonSide, onRelay: (m) => void r.m.endpoints.relay.onRelay(r.m.endpoints.source, m).then((outs) => outs.forEach((o) => port?.relay(o as never))) });
  t.after(() => port?.dispose());
  const cleanups: (() => void)[] = [];
  const cli = wireCliEndpoints(true, { onRelay: () => ({ dispose: () => undefined }), relay: (m: RelayOut) => port?.relay(m as never) ?? false }, r.m.endpoints, cleanups) as CliEndpoints;
  const runId = r.run("c1");
  await cliEndpointPty(port as unknown as PtyPort, () => cli).spawn({ ...SPEC, runId });
  const env = requests[0]?.env ?? {};
  const path = env["AXIS_MESSAGES_ENDPOINT"] as string;
  assert.ok(existsSync(path) && typeof env["AXIS_MESSAGES_TOKEN"] === "string");
  const s = connect(path);
  t.after(() => s.destroy());
  await new Promise<void>((res) => s.once("connect", () => res()));
  assert.deepEqual(await call(s, { op: "auth", token: env["AXIS_MESSAGES_TOKEN"] }), { ok: true, op: "auth" });
  const sent = await call(s, { op: "send", id: "s1", recipients: [{ agent: "a1" }], body: "hello from the cli" });
  assert.equal(sent["ok"], true);
  const got = r.m.service.read({ kind: "agent", agentId: "a1", runId: null, verified: true, receivedHop: 0 }, {}).messages;
  assert.deepEqual(got.map((m) => [m.sender, m.body.text]), [[{ kind: "agent", agentId: "c1", runId, verified: false }, "hello from the cli"]]);
  const read = await call(s, { op: "read", id: "r1" });
  assert.equal(read["ok"], true);
  const closed = new Promise<void>((res) => s.once("close", () => res()));
  children[0]?.end();
  await closed;
  assert.equal(existsSync(path), false, "the socket went with the run");
  cleanups.forEach((c) => c());
});

/** A live CLI endpoint over a real socket for worker c1 (group g1), and a connected, authenticated client: slice 3's rig. */
async function liveEndpoint(t: TestContext) {
  const r = await deliveryRig(t, { noDelivery: true });
  r.c.journal.messages.setAgentSettings("c1", { acceptsFrom: "group", cliMessaging: true, muted: false });
  const base = mkdtempSync(join(tmpdir(), "axep-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const [daemonSide, ptySide] = pair();
  const requests: SpawnRequest[] = [];
  const service = createPtyService({ spawn: (req) => (requests.push(req), child()), messagesEndpoints: { dir: join(base, "d"), platform: process.platform, uid: process.getuid?.() ?? -1 } });
  t.after(() => service.dispose());
  service.serveControl(ptySide);
  let port: ReturnType<typeof createPtyProcessPort> | undefined;
  port = createPtyProcessPort({ channel: daemonSide, onRelay: (m) => void r.m.endpoints.relay.onRelay(r.m.endpoints.source, m).then((outs) => outs.forEach((o) => port?.relay(o as never))) });
  t.after(() => port?.dispose());
  const cleanups: (() => void)[] = [];
  t.after(() => cleanups.forEach((c) => c()));
  const cli = wireCliEndpoints(true, { onRelay: () => ({ dispose: () => undefined }), relay: (m: RelayOut) => port?.relay(m as never) ?? false }, r.m.endpoints, cleanups) as CliEndpoints;
  await cliEndpointPty(port as unknown as PtyPort, () => cli).spawn({ ...SPEC, runId: r.run("c1") });
  const env = requests[0]?.env ?? {};
  const path = env["AXIS_MESSAGES_ENDPOINT"] as string;
  const token = env["AXIS_MESSAGES_TOKEN"] as string;
  const open = async (): Promise<Socket & { gone: Promise<void> }> => {
    const s = connect(path) as Socket & { gone: Promise<void> };
    s.on("error", () => undefined);
    s.gone = new Promise<void>((res) => s.once("close", () => res()));
    t.after(() => s.destroy());
    await new Promise<void>((res, rej) => (s.once("connect", () => res()), s.once("error", rej)));
    assert.deepEqual(await call(s, { op: "auth", token }), { ok: true, op: "auth" });
    return s;
  };
  return { r, path, open, s: await open() };
}
/** Resolves true when `p` settles within the bound, false otherwise: a test fails by name instead of hanging. */
const within = (p: Promise<unknown>, ms = 3000): Promise<boolean> => Promise.race([p.then(() => true), new Promise<boolean>((res) => setTimeout(() => res(false), ms).unref())]);
const USER = { kind: "user" } as const;

test("PV-M6 slice 3: turning a worker's CLI messaging off revokes its endpoint at once: the client closes, the socket file and listener are gone", { skip }, async (t) => {
  const { r, path, s } = await liveEndpoint(t);
  const out = r.m.settings.updateSettings(USER, { setting: "cliMessaging", agentId: "c1", value: false });
  assert.equal(out.changed, true);
  assert.equal(await within(s.gone), true, "the open connection was closed");
  assert.equal(await within((async () => { while (existsSync(path)) await new Promise((res) => setTimeout(res, 10)); })()), true, "the socket file is gone");
  const again = connect(path);
  t.after(() => again.destroy());
  assert.equal(await new Promise<string>((res) => (again.once("error", (e: NodeJS.ErrnoException) => res(e.code ?? "error")), again.once("connect", () => res("connected")))) !== "connected", true, "nothing listens");
  assert.ok(rows(r).some((p) => p["event"] === "revoked"), "the revocation is audited");
});

test("PV-M6 slice 3: a pause of the worker's group drops its connections but keeps the listener; a paused request is refused and a resume needs nothing", { skip }, async (t) => {
  const { r, path, s, open } = await liveEndpoint(t);
  r.m.settings.pause(USER, { scope: { group: "g2" } }); // another group: c1 is not paused
  assert.equal(await within(s.gone, 300), false, "a pause out of scope leaves the connection open");
  r.m.settings.pause(USER, { scope: { group: "g1" } });
  assert.equal(await within(s.gone), true, "the connection was dropped");
  assert.ok(existsSync(path), "the listener and its socket stay");
  const s2 = await open(); // a new connection may still authenticate
  assert.deepEqual(await call(s2, { op: "send", id: "s1", recipients: [{ agent: "a1" }], body: "x" }), { ok: false, reason: "paused" });
  assert.equal(await within(s2.gone), true, "a paused request closes its connection");
  r.m.settings.resume(USER, { scope: { group: "g1" } });
  const s3 = await open();
  assert.equal((await call(s3, { op: "send", id: "s2", recipients: [{ agent: "a1" }], body: "after resume" }))["ok"], true, "after resume the same socket serves");
  assert.ok(rows(r).some((p) => p["event"] === "paused" && p["connections"] === 1), "the drop is audited with its count");
});

test("PV-M6 slice 3: a settings hook that throws is audited and never fails the user's write", async (t) => {
  const r = await deliveryRig(t, { noDelivery: true });
  r.c.journal.messages.setAgentSettings("c1", { acceptsFrom: "group", cliMessaging: true, muted: false });
  const off = r.m.endpoints.onSettings(() => {
    throw new Error("boom");
  });
  t.after(off);
  assert.equal(r.m.settings.updateSettings(USER, { setting: "cliMessaging", agentId: "c1", value: false }).changed, true);
  assert.equal(r.m.settings.pause(USER, { scope: { project: "p" } }).changed, true);
  assert.equal(r.m.settings.updateSettings(USER, { setting: "cliMessaging", agentId: "c1", value: false }).changed, false);
  assert.equal(r.m.settings.pause(USER, { scope: { project: "p" } }).changed, false);
  r.m.settings.updateSettings(USER, { setting: "muted", agentId: "c1", value: true });
  assert.deepEqual(rows(r).filter((p) => p["event"] === "hook_failed").map((p) => p["agentId"] ?? p["projectId"]), ["c1", "p"], "only a change that took effect, only cliMessaging off or a pause");
  assert.equal(r.c.journal.messages.agentSettings("c1")?.cliMessaging, false, "the write stands");
});
const rows = (r: Awaited<ReturnType<typeof deliveryRig>>) => r.c.audit.list({ limit: 5000 }).filter((e) => e.action === "message.endpoint").map((e) => e.payload as Record<string, unknown>);

test("review s3 N2: a hook that throws AND an audit sink that throws still leave the committed write a success", async (t) => {
  const r = await deliveryRig(t, { noDelivery: true });
  r.c.journal.messages.setAgentSettings("c1", { acceptsFrom: "group", cliMessaging: true, muted: false });
  const settings = createMessagingSettings({
    store: r.c.journal.messages,
    directory: r.m.participation.directory,
    audit: { append: (e) => (e.payload !== undefined && (e.payload as Record<string, unknown>)["event"] === "hook_failed" ? assert.fail("the sink fails") : r.c.audit.append(e)) },
    context: (id) => r.m.service.context(id),
    onChange: () => {
      throw new Error("boom");
    },
  });
  assert.equal(settings.updateSettings(USER, { setting: "cliMessaging", agentId: "c1", value: false }).changed, true);
  assert.equal(settings.pause(USER, { scope: { project: "p" } }).changed, true);
  assert.equal(r.c.journal.messages.agentSettings("c1")?.cliMessaging, false, "the write stands");
});
