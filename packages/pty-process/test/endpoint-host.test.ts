// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test, type TestContext } from "node:test";
import { ENDPOINT_HOST_LIMITS, LINGER_MS, PtySpawnError, createEndpointHost, endpointDirOk, isEndpointPath, type EndpointHost, type RelayInbound } from "../src/index.js";
import { ManualClock, counterRandom } from "../testing/helpers.js";
import { rig, SPEC } from "../testing/rig.js";

// PV-M6 slice 2: the messaging endpoint's listener in the pty process, over real Unix sockets (ADR 0007 decisions 7.1 to 7.4;
// endpoint design sections 2, 3 and 7). Windows has no endpoint (no native pipe helper): those cases are skipped by name.

const posix = process.platform !== "win32";
const skip = posix ? undefined : "Unix sockets: Windows has no messaging endpoint until the native pipe helper exists";
const EP = `ep_${"A".repeat(43)}`;
const TOKEN = "T".repeat(43);
const uid = posix ? process.getuid?.() ?? -1 : -1;

/** A fresh 0700 directory with a short path (a socket path is limited to about 100 bytes). */
function dir(t: TestContext): string {
  const base = mkdtempSync(join(tmpdir(), "axep-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return join(base, "d");
}

interface Host {
  readonly host: EndpointHost;
  readonly sent: RelayInbound[];
  readonly clock: DelayClock;
  readonly dir: string;
}
function host(t: TestContext, limits?: { writeBufferBytes?: number; slowReaderMs?: number }): Host {
  const sent: RelayInbound[] = [];
  const clock = new DelayClock();
  const d = dir(t);
  const h = createEndpointHost({ dir: d, platform: process.platform, uid }, { send: (m) => (sent.push(m), true), clock, random: counterRandom(), ...(limits === undefined ? {} : { limits }) });
  t.after(() => h.closeAll());
  return { host: h, sent, clock, dir: d };
}

const frame = (body: string | Buffer, declared?: number): Buffer => {
  const b = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  const head = Buffer.alloc(4);
  head.writeUInt32BE(declared ?? b.length, 0);
  return Buffer.concat([head, b]);
};
async function dial(path: string, allowHalfOpen = false): Promise<Socket & { ended: Promise<void>; got: Buffer[] }> {
  const s = connect({ path, allowHalfOpen }) as Socket & { ended: Promise<void>; got: Buffer[] };
  s.got = [];
  s.on("data", (d: Buffer) => s.got.push(d));
  s.ended = new Promise((res) => s.on("close", () => res()));
  s.on("error", () => undefined);
  await new Promise<void>((res, rej) => (s.once("connect", () => res()), s.once("error", rej)));
  return s;
}
/** The socket's close, or a failure by name after 3 s (never a hang). */
async function closes(s: { ended: Promise<void> }, what: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_res, rej) => (timer = setTimeout(() => rej(new Error(`${what}: the connection was not closed`)), 3_000)));
  try {
    await Promise.race([s.ended, late]);
  } finally {
    clearTimeout(timer);
  }
}
/** A clock that records each timer's delay (the bound it stands for). */
class DelayClock {
  readonly timers = new Map<number, { fn: () => void; ms: number }>();
  private next = 1;
  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.next++;
    this.timers.set(id, { fn, ms });
    return id;
  }
  clearTimeout(id: unknown): void {
    this.timers.delete(id as number);
  }
  delays(): number[] {
    return [...this.timers.values()].map((t) => t.ms);
  }
  fire(): void {
    for (const [id, t] of [...this.timers]) {
      this.timers.delete(id);
      t.fn();
    }
  }
}
/** Wait (bounded) until `pred` holds; fails by name instead of hanging. */
async function until(pred: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (pred()) return;
    await new Promise((res) => setTimeout(res, 5));
  }
  assert.fail(`${what} not reached`);
}
const ofType = (sent: readonly RelayInbound[], t: RelayInbound["t"]) => sent.filter((m) => m.t === t);

test("the runtime directory is the control: created 0700; a 0755 one, a symlink, or a file is refused", { skip }, (t) => {
  const d = dir(t);
  assert.equal(endpointDirOk(d, uid), true, "created");
  const open = join(d, "..", "open");
  mkdirSync(open, { mode: 0o700 });
  chmodSync(open, 0o755);
  assert.equal(endpointDirOk(open, uid), false, "0755");
  const link = join(d, "..", "link");
  symlinkSync(d, link);
  assert.equal(endpointDirOk(link, uid), false, "a symlink, even to a good directory");
  assert.equal(endpointDirOk(d, uid + 1), false, "another owner");
});

test("an endpoint relays open, each frame as its text, and close; the daemon's reply comes back framed", { skip }, async (t) => {
  const h = host(t);
  const path = await h.host.open(EP);
  assert.ok(path !== undefined && path.startsWith(h.dir) && Buffer.byteLength(path) <= ENDPOINT_HOST_LIMITS.pathBytes);
  const s = await dial(path);
  await until(() => ofType(h.sent, "relay-open").length === 1, "relay-open");
  const conn = (h.sent[0] as { conn: string }).conn;
  s.write(frame(JSON.stringify({ op: "auth", token: TOKEN })));
  await until(() => ofType(h.sent, "relay-frame").length === 1, "the auth frame");
  assert.deepEqual(ofType(h.sent, "relay-frame")[0], { t: "relay-frame", endpoint: EP, conn, frame: JSON.stringify({ op: "auth", token: TOKEN }) });
  h.host.onRelay({ t: "relay-reply", endpoint: EP, conn, frame: '{"ok":true,"op":"auth"}', close: false, authFailed: false });
  await until(() => Buffer.concat(s.got).length > 0, "the reply");
  assert.deepEqual(Buffer.concat(s.got), frame('{"ok":true,"op":"auth"}'));
  s.write(frame("x".repeat(ENDPOINT_HOST_LIMITS.authFrameBytes + 10)), () => undefined);
  await until(() => ofType(h.sent, "relay-frame").length === 2, "an authenticated frame past the auth cap is relayed");
  s.destroy();
  await until(() => ofType(h.sent, "relay-close").length === 1, "relay-close");
});

test("the socket file is mode 0600 and owned by this uid, in the 0700 runtime directory", { skip }, async (t) => {
  const h = host(t);
  const path = (await h.host.open(EP)) as string;
  const st = lstatSync(path);
  assert.ok(st.isSocket());
  assert.equal(st.mode & 0o777, 0o600);
  assert.equal(st.uid, uid);
  assert.equal(lstatSync(h.dir).mode & 0o777, 0o700);
});

test("endpoint line 3: a fifth connection is closed at accept", { skip }, async (t) => {
  const h = host(t);
  const path = (await h.host.open(EP)) as string;
  const four = await Promise.all([dial(path), dial(path), dial(path), dial(path)]);
  await until(() => ofType(h.sent, "relay-open").length === 4, "four opened");
  const fifth = await dial(path);
  await closes(fifth, "a fifth connection");
  assert.equal(ofType(h.sent, "relay-open").length, 4);
  four.forEach((s) => s.destroy());
});

test("endpoint line 3: no auth within 2 s, an auth frame over 512 bytes, or a 64 KiB unframed write before auth closes the connection", { skip }, async (t) => {
  const h = host(t);
  const path = (await h.host.open(EP)) as string;
  const idle = await dial(path);
  await until(() => h.clock.timers.size === 1, "the pre-auth timer");
  assert.deepEqual(h.clock.delays(), [ENDPOINT_HOST_LIMITS.preAuthMs]);
  h.clock.fire();
  await closes(idle, "no auth within 2 s");
  const big = await dial(path);
  big.write(frame("y".repeat(ENDPOINT_HOST_LIMITS.authFrameBytes + 1)), () => undefined);
  await closes(big, "an auth frame over 512 bytes");
  const declared = await dial(path);
  declared.write(frame(Buffer.alloc(0), ENDPOINT_HOST_LIMITS.authFrameBytes + 1), () => undefined);
  await closes(declared, "a header alone declaring an auth frame over the cap");
  const flood = await dial(path);
  flood.write(Buffer.alloc(64 * 1024 + 1, 0x41), () => undefined);
  await closes(flood, "a 64 KiB unframed write");
  const waiting = await dial(path);
  waiting.write(frame(`{"op":"auth","token":"${TOKEN}"}`));
  await until(() => ofType(h.sent, "relay-frame").length === 1, "the auth");
  waiting.write(Buffer.alloc(8 * 1024, 0x42), () => undefined);
  await closes(waiting, "a flood while the auth waits for its answer");
  assert.equal(ofType(h.sent, "relay-frame").length, 1, "only the one auth was relayed");
});

test("endpoint line 3: after auth, a frame over 64 KiB or not UTF-8 closes; nothing is relayed before the auth is answered", { skip }, async (t) => {
  const h = host(t);
  const path = (await h.host.open(EP)) as string;
  const authed = async (): Promise<{ s: Awaited<ReturnType<typeof dial>>; conn: string }> => {
    const before = ofType(h.sent, "relay-open").length;
    const s = await dial(path);
    await until(() => ofType(h.sent, "relay-open").length === before + 1, "opened");
    const conn = (ofType(h.sent, "relay-open").at(-1) as { conn: string }).conn;
    s.write(frame(`{"op":"auth","token":"${TOKEN}"}`));
    s.write(frame('{"op":"read","id":"early"}'));
    await until(() => ofType(h.sent, "relay-frame").some((m) => m.conn === conn), "the auth");
    assert.equal(ofType(h.sent, "relay-frame").filter((m) => m.conn === conn).length, 1, "the read waits for the auth's answer");
    h.host.onRelay({ t: "relay-reply", endpoint: EP, conn, frame: "{}", close: false, authFailed: false });
    await until(() => ofType(h.sent, "relay-frame").filter((m) => m.conn === conn).length === 2, "then the read is relayed");
    return { s, conn };
  };
  const a = await authed();
  a.s.write(frame(Buffer.alloc(0), ENDPOINT_HOST_LIMITS.frameBytes + 1), () => undefined);
  await closes(a.s, "a frame over 64 KiB");
  const b = await authed();
  b.s.write(frame(Buffer.from([0xff, 0xfe, 0x00])), () => undefined);
  await closes(b.s, "a frame that is not UTF-8");
});

test("a daemon reply with close (a failed token) closes the connection and tells the daemon; endpoint-close removes everything", { skip }, async (t) => {
  const h = host(t);
  const path = (await h.host.open(EP)) as string;
  const s = await dial(path);
  await until(() => ofType(h.sent, "relay-open").length === 1, "opened");
  const conn = (h.sent[0] as { conn: string }).conn;
  h.host.onRelay({ t: "relay-reply", endpoint: EP, conn, frame: '{"ok":false,"reason":"bad_token"}', close: true, authFailed: true });
  await closes(s, "a reply with close");
  assert.deepEqual(ofType(h.sent, "relay-close"), [{ t: "relay-close", endpoint: EP, conn }], "the daemon forgets the failed connection");
  const s2 = await dial(path);
  h.host.onRelay({ t: "endpoint-close", endpoint: EP, reason: "revoked" });
  await closes(s2, "endpoint-close");
  assert.equal(existsSync(path), false, "the socket file is removed");
});

test("an authenticated connection idle for 10 minutes is closed", { skip }, async (t) => {
  const h = host(t);
  const path = (await h.host.open(EP)) as string;
  const s = await dial(path);
  await until(() => ofType(h.sent, "relay-open").length === 1, "opened");
  const conn = (h.sent[0] as { conn: string }).conn;
  s.write(frame(`{"op":"auth","token":"${TOKEN}"}`));
  await until(() => ofType(h.sent, "relay-frame").length === 1, "auth");
  h.host.onRelay({ t: "relay-reply", endpoint: EP, conn, frame: "{}", close: false, authFailed: false });
  await until(() => Buffer.concat(s.got).length > 0, "answered");
  assert.deepEqual(h.clock.delays(), [ENDPOINT_HOST_LIMITS.idleMs], "the pre-auth bound is replaced by the idle bound");
  h.clock.fire();
  await closes(s, "an idle authenticated connection");
});

test("no endpoint on Windows; an endpoint id of the wrong shape or opened twice is refused", { skip }, async (t) => {
  const h = host(t);
  const win = createEndpointHost({ dir: h.dir, platform: "win32", uid }, { send: () => true, clock: new ManualClock(), random: counterRandom() });
  t.after(() => win.closeAll());
  assert.equal(await win.open(EP), undefined);
  assert.equal(await h.host.open("ep_short"), undefined);
  assert.ok((await h.host.open(EP)) !== undefined);
  assert.equal(await h.host.open(EP), undefined);
});

test("ADR 0007 amendment item 1: a spawn asking for an endpoint gets exactly the two names, after the PTY-5 check; the socket goes with the run", { skip }, async (t) => {
  const d = dir(t);
  const r = rig({ endpoints: { dir: d, platform: process.platform, uid } });
  t.after(() => r.service.dispose());
  await r.port.spawn({ ...SPEC, messagesEndpoint: { endpoint: EP, token: TOKEN } });
  const env = r.requests[0]?.env ?? {};
  const added = Object.keys(env).filter((k) => !(k in SPEC.env));
  assert.deepEqual(added.sort(), ["AXIS_MESSAGES_ENDPOINT", "AXIS_MESSAGES_TOKEN"]);
  assert.equal(env["AXIS_MESSAGES_TOKEN"], TOKEN);
  const path = env["AXIS_MESSAGES_ENDPOINT"] as string;
  assert.ok(path.startsWith(d) && existsSync(path));
  r.children[0]?.exit();
  await until(() => !existsSync(path), "the socket is removed when the run's child exits");
});

test("ADR 0007 validation 4 and endpoint line 1: without the request, or without the listener configured, no name is added; a spawn env carrying either name in any case is refused", async () => {
  const plain = rig();
  await plain.port.spawn(SPEC);
  assert.deepEqual(plain.requests[0]?.env, SPEC.env, "no request: nothing added");
  await assert.rejects(plain.port.spawn({ ...SPEC, messagesEndpoint: { endpoint: EP, token: TOKEN } }), (e: unknown) => e instanceof PtySpawnError && e.code === "endpoint_unavailable");
  assert.equal(plain.requests.length, 1, "nothing was started for the refused one");
  for (const name of ["AXIS_MESSAGES_ENDPOINT", "AXIS_MESSAGES_TOKEN", "axis_messages_token", "Axis_Messages_Endpoint"]) {
    await assert.rejects(plain.port.spawn({ ...SPEC, env: { ...SPEC.env, [name]: "x" } }), (e: unknown) => e instanceof PtySpawnError && e.code === "env_denied", name);
  }
});

test("review: only an absolute path is ever listened on: a relative or numeric directory opens nothing (a numeric string would be a TCP port)", { skip }, async (t) => {
  for (const p of ["8080", " 8080 ", "0", "rel/a.sock", "./a.sock"]) assert.equal(isEndpointPath(p), false, p);
  assert.equal(isEndpointPath("/run/user/1000/axis/a.sock"), true);
  const listened: unknown[] = [];
  const net = await import("node:net");
  const original = net.Server.prototype.listen;
  net.Server.prototype.listen = function (this: unknown, ...args: unknown[]) {
    listened.push(args[0]);
    return original.apply(this as never, args as never);
  } as typeof original;
  t.after(() => void (net.Server.prototype.listen = original));
  for (const dirName of ["8080", "relative-dir"]) {
    const h = createEndpointHost({ dir: dirName, platform: process.platform, uid }, { send: () => true, clock: new ManualClock(), random: counterRandom() });
    assert.equal(await h.open(EP), undefined, dirName);
  }
  assert.deepEqual(listened, [], "listen was never called");
  assert.equal(existsSync("relative-dir") || existsSync("8080"), false, "and nothing was created in the working directory");
});

test("review 1 N1: the endpoint's bounds are these literal values", () => {
  assert.deepEqual({ ...ENDPOINT_HOST_LIMITS }, { connections: 4, authFrameBytes: 512, frameBytes: 65536, preAuthMs: 2000, idleMs: 600000, pendingFrames: 4, pathBytes: 100, writeBufferBytes: 4194304, slowReaderMs: 60000 });
});

/** An open, authenticated connection: the socket, its relay id, and a way to relay the daemon's answer to its next frame. */
async function authedConn(h: Host, path: string, allowHalfOpen = false): Promise<{ s: Awaited<ReturnType<typeof dial>>; conn: string }> {
  const before = ofType(h.sent, "relay-open").length;
  const s = await dial(path, allowHalfOpen);
  await until(() => ofType(h.sent, "relay-open").length === before + 1, "opened");
  const conn = (ofType(h.sent, "relay-open").at(-1) as { conn: string }).conn;
  s.write(frame(`{"op":"auth","token":"${TOKEN}"}`));
  await until(() => ofType(h.sent, "relay-frame").some((m) => m.conn === conn), "the auth");
  h.host.onRelay({ t: "relay-reply", endpoint: EP, conn, frame: "{}", close: false, authFailed: false });
  await until(() => Buffer.concat(s.got).length > 0, "the auth answer");
  return { s, conn };
}

test("review 1 S1: four frames may wait for the daemon's answer; a fifth closes the connection", { skip }, async (t) => {
  const h = host(t);
  const path = (await h.host.open(EP)) as string;
  const { s, conn } = await authedConn(h, path);
  for (let i = 0; i < 4; i++) s.write(frame(`{"op":"read","id":"r${i}"}`));
  await until(() => ofType(h.sent, "relay-frame").filter((m) => m.conn === conn).length === 5, "four requests relayed (after the auth)");
  assert.equal(ofType(h.sent, "relay-close").length, 0, "four unanswered are allowed");
  s.write(frame('{"op":"read","id":"r4"}'));
  await closes(s, "a fifth unanswered frame");
  assert.equal(ofType(h.sent, "relay-frame").filter((m) => m.conn === conn).length, 5, "the fifth was not relayed");
});

test("review 1 B1: a client that never reads is dropped once its unread replies pass the cap (the reviewer's PoC)", { skip }, async (t) => {
  const cap = 256 * 1024;
  const h = host(t, { writeBufferBytes: cap });
  const path = (await h.host.open(EP)) as string;
  const { s, conn } = await authedConn(h, path);
  s.pause(); // never reads again
  const big = JSON.stringify({ ok: true, pad: "x".repeat(200 * 1024) });
  let sent = 0;
  for (let i = 0; i < 64 && ofType(h.sent, "relay-close").every((m) => m.conn !== conn); i++) {
    s.write(frame(`{"op":"read","id":"r${i}"}`));
    await until(() => ofType(h.sent, "relay-frame").filter((m) => m.conn === conn).length === i + 2 || ofType(h.sent, "relay-close").some((m) => m.conn === conn), "relayed or dropped");
    if (ofType(h.sent, "relay-close").some((m) => m.conn === conn)) break;
    h.host.onRelay({ t: "relay-reply", endpoint: EP, conn, frame: big, close: false, authFailed: false });
    sent += big.length;
  }
  assert.ok(ofType(h.sent, "relay-close").some((m) => m.conn === conn), "the connection was dropped");
  assert.ok(sent <= cap * 8, `bounded: the host wrote ${sent} bytes before dropping it (cap ${cap}, plus what the kernel holds)`);
});

test("review 1 B1: one reply larger than the cap, left unread, drops the connection at once (no later frame needed)", { skip }, async (t) => {
  const h = host(t, { writeBufferBytes: 256 * 1024 });
  const path = (await h.host.open(EP)) as string;
  const { s, conn } = await authedConn(h, path);
  s.pause();
  s.write(frame('{"op":"read","id":"r0"}'));
  await until(() => ofType(h.sent, "relay-frame").filter((m) => m.conn === conn).length === 2, "relayed");
  h.host.onRelay({ t: "relay-reply", endpoint: EP, conn, frame: JSON.stringify({ pad: "v".repeat(2 * 1024 * 1024) }), close: false, authFailed: false });
  assert.equal(ofType(h.sent, "relay-close").filter((m) => m.conn === conn).length, 1, "dropped right after the write that passed the cap");
});

test("review 1 B1: unread replies that do not drain for the slow-reader bound drop the connection", { skip }, async (t) => {
  const h = host(t, { writeBufferBytes: 64 * 1024 * 1024 });
  const path = (await h.host.open(EP)) as string;
  const { s, conn } = await authedConn(h, path);
  s.pause();
  s.write(frame('{"op":"read","id":"r0"}'));
  await until(() => ofType(h.sent, "relay-frame").filter((m) => m.conn === conn).length === 2, "relayed");
  h.host.onRelay({ t: "relay-reply", endpoint: EP, conn, frame: JSON.stringify({ pad: "y".repeat(8 * 1024 * 1024) }), close: false, authFailed: false });
  assert.ok(h.clock.delays().includes(ENDPOINT_HOST_LIMITS.slowReaderMs), `the slow-reader clock runs: ${h.clock.delays()}`);
  assert.ok(ofType(h.sent, "relay-close").every((m) => m.conn !== conn), "not yet: the backlog is under the cap");
  for (const [id, tm] of [...h.clock.timers]) if (tm.ms === ENDPOINT_HOST_LIMITS.slowReaderMs) (h.clock.timers.delete(id), tm.fn());
  // The client is paused, so it does not see the close itself: the host's relay-close says the connection was dropped.
  assert.deepEqual(ofType(h.sent, "relay-close").filter((m) => m.conn === conn).length, 1, "dropped at the slow-reader bound");
});

test("review 1 N2: two concurrent opens of one endpoint: the second is refused, one listener, one socket", { skip }, async (t) => {
  // Every server this test starts is closed when it ends, so a leaked listener fails it by name instead of holding the process.
  const net = await import("node:net");
  const started: { close(): void }[] = [];
  const original = net.Server.prototype.listen;
  net.Server.prototype.listen = function (this: { close(): void }, ...args: unknown[]) {
    started.push(this);
    return original.apply(this as never, args as never);
  } as typeof original;
  t.after(() => {
    net.Server.prototype.listen = original;
    for (const srv of started) srv.close();
  });
  const h = host(t);
  const [a, b] = await Promise.all([h.host.open(EP), h.host.open(EP)]);
  assert.deepEqual([typeof a, b], ["string", undefined]);
  assert.deepEqual(readdirSync(h.dir), [basename(a as string)], "one socket file");
  assert.equal(started.length, 1, "one listener");
});

test("review 1 B1: a reply counts as unanswered until the reader takes it: four unread replies and a fifth frame close the connection", { skip }, async (t) => {
  const h = host(t, { writeBufferBytes: 64 * 1024 * 1024 });
  const path = (await h.host.open(EP)) as string;
  const { s, conn } = await authedConn(h, path);
  s.pause();
  const big = JSON.stringify({ pad: "z".repeat(1024 * 1024) }); // larger than what the kernel holds, so it stays unread
  for (let i = 0; i < 4; i++) {
    s.write(frame(`{"op":"read","id":"r${i}"}`));
    await until(() => ofType(h.sent, "relay-frame").filter((m) => m.conn === conn).length === i + 2, `request ${i} relayed`);
    h.host.onRelay({ t: "relay-reply", endpoint: EP, conn, frame: big, close: false, authFailed: false });
  }
  assert.equal(ofType(h.sent, "relay-close").filter((m) => m.conn === conn).length, 0, "four, answered but unread, are allowed");
  s.write(frame('{"op":"read","id":"r4"}'));
  await until(() => ofType(h.sent, "relay-close").some((m) => m.conn === conn), "the fifth frame drops it");
  assert.equal(ofType(h.sent, "relay-frame").filter((m) => m.conn === conn).length, 5, "the fifth was not relayed");
});

test("review 1 B1: a frame from a connection whose unread replies are above half the cap does not refresh its idle timer", { skip }, async (t) => {
  const h = host(t, { writeBufferBytes: 2 * 1024 * 1024 });
  const path = (await h.host.open(EP)) as string;
  const { s, conn } = await authedConn(h, path);
  s.pause();
  s.write(frame('{"op":"read","id":"r0"}'));
  await until(() => ofType(h.sent, "relay-frame").filter((m) => m.conn === conn).length === 2, "relayed");
  h.host.onRelay({ t: "relay-reply", endpoint: EP, conn, frame: JSON.stringify({ pad: "w".repeat(1536 * 1024) }), close: false, authFailed: false });
  const idleIds = () => [...h.clock.timers].filter(([, tm]) => tm.ms === ENDPOINT_HOST_LIMITS.idleMs).map(([id]) => id);
  const before = idleIds();
  s.write(frame('{"op":"read","id":"r1"}'));
  await until(() => ofType(h.sent, "relay-frame").filter((m) => m.conn === conn).length === 3, "relayed");
  assert.deepEqual(idleIds(), before, "the idle timer was not re-armed");
});

/** Resume a paused client and count the bytes it gets until its socket closes (bounded wait; fails by name). */
async function drainCount(s: Awaited<ReturnType<typeof dial>>, what: string): Promise<number> {
  let n = 0; // every byte after the resume
  s.on("data", (d: Buffer) => void (n += d.length)).resume();
  return closes(s, what).then(() => n);
}

test("review 2 B1: a closing reply to a peer that never reads destroys its socket at once; 40 cycles leave nothing open after closeAll (the closepath PoC)", { skip }, async (t) => {
  const h = host(t, { writeBufferBytes: 64 * 1024 * 1024 });
  const path = (await h.host.open(EP)) as string;
  const reply = JSON.stringify({ ok: false, reason: "refused", pad: "q".repeat(512 * 1024) });
  const clients: Awaited<ReturnType<typeof dial>>[] = [];
  t.after(() => clients.forEach((s) => s.destroy())); // a leaked socket fails the test by name, never holds the process
  const rss0 = process.memoryUsage().rss;
  for (let i = 0; i < 40; i++) {
    const { s, conn } = await authedConn(h, path);
    s.pause(); // never reads the closing reply
    clients.push(s);
    h.host.onRelay({ t: "relay-reply", endpoint: EP, conn, frame: reply, close: true, authFailed: false });
    assert.ok(ofType(h.sent, "relay-close").some((m) => m.conn === conn), `cycle ${i}: the daemon is told`);
  }
  assert.equal([...h.clock.timers.values()].filter((tm) => tm.ms === LINGER_MS).length, 0, "with the reply unread, each was destroyed at once, none left ended and lingering");
  h.host.closeAll();
  const got = await Promise.all(clients.map((s, i) => drainCount(s, `client ${i}`))); // one shared bound, not 40 in a row
  for (const [i, n] of got.entries()) assert.ok(n < reply.length, `client ${i}: its socket was destroyed, not ended (it got ${n} of ${reply.length} bytes)`);
  assert.ok(process.memoryUsage().rss - rss0 < 96 * 1024 * 1024, "memory bounded");
});

test("review 2 B1: a closing reply the peer has taken ends the socket with a linger timer; closeAll destroys a lingering one", { skip }, async (t) => {
  const h = host(t);
  const path = (await h.host.open(EP)) as string;
  const { s, conn } = await authedConn(h, path, true); // half-open: it keeps its side open after the host ends
  t.after(() => s.destroy());
  h.host.onRelay({ t: "relay-reply", endpoint: EP, conn, frame: '{"ok":false,"reason":"refused"}', close: true, authFailed: false });
  await until(() => [...h.clock.timers.values()].some((tm) => tm.ms === LINGER_MS), "a linger timer for the ended connection");
  h.host.closeAll();
  assert.equal([...h.clock.timers.values()].filter((tm) => tm.ms === LINGER_MS).length, 0, "closeAll cleared the linger timer");
  let closed = false; // review 3 nit B: the lingering socket itself is destroyed, so the client's writes fail and it closes
  void s.ended.then(() => (closed = true));
  await until(() => (closed || s.write(frame('{"op":"read","id":"x"}')), closed), "the lingering socket destroyed by closeAll");
});

test("review 3 nit A: a lingering connection's data is discarded: no frame relayed, no timer armed", { skip }, async (t) => {
  const h = host(t);
  const path = (await h.host.open(EP)) as string;
  const { s, conn } = await authedConn(h, path, true);
  t.after(() => s.destroy());
  h.host.onRelay({ t: "relay-reply", endpoint: EP, conn, frame: '{"ok":false,"reason":"refused"}', close: true, authFailed: false });
  await until(() => [...h.clock.timers.values()].some((tm) => tm.ms === LINGER_MS), "lingering");
  const frames0 = ofType(h.sent, "relay-frame").length;
  const timers0 = h.clock.delays().length;
  s.write(frame('{"op":"read","id":"late"}'));
  const marker = await dial(path); // a marker after it: a second connection's open
  t.after(() => marker.destroy());
  await until(() => ofType(h.sent, "relay-open").length === 2, "the marker connection");
  await new Promise((res) => setTimeout(res, 50));
  assert.equal(ofType(h.sent, "relay-frame").length, frames0, "nothing relayed for a connection the daemon forgot");
  assert.equal(h.clock.delays().length, timers0 + 1, "only the marker's pre-auth timer was armed");
});

test("review 2 N5: the slow-reader clock re-arms while the backlog shrinks and drops only when it did not", { skip }, async (t) => {
  const h = host(t, { writeBufferBytes: 64 * 1024 * 1024 });
  const path = (await h.host.open(EP)) as string;
  const { s, conn } = await authedConn(h, path);
  s.pause();
  // Three replies of about 1 MiB: progress is seen per reply (a write leaves `buffered()` only once all of it is taken).
  for (let i = 0; i < 3; i++) {
    s.write(frame(`{"op":"read","id":"r${i}"}`));
    await until(() => ofType(h.sent, "relay-frame").filter((m) => m.conn === conn).length === i + 2, `request ${i} relayed`);
    h.host.onRelay({ t: "relay-reply", endpoint: EP, conn, frame: JSON.stringify({ pad: "p".repeat(1000 * 1024) }), close: false, authFailed: false });
  }
  const fireSlow = (): void => [...h.clock.timers].forEach(([id, tm]) => tm.ms === ENDPOINT_HOST_LIMITS.slowReaderMs && (h.clock.timers.delete(id), tm.fn()));
  // The reader takes some of it, then stops again: the backlog shrank, so the clock re-arms instead of dropping.
  await new Promise<void>((res) => {
    let n = 0;
    const take = (d: Buffer): void => void ((n += d.length) >= 1536 * 1024 && (s.off("data", take), s.pause(), res()));
    s.on("data", take);
    s.resume();
  });
  await new Promise((res) => setTimeout(res, 50));
  fireSlow();
  assert.equal(ofType(h.sent, "relay-close").filter((m) => m.conn === conn).length, 0, "a draining reader is kept");
  assert.ok(h.clock.delays().includes(ENDPOINT_HOST_LIMITS.slowReaderMs), "and the clock runs again");
  fireSlow(); // no progress since
  assert.equal(ofType(h.sent, "relay-close").filter((m) => m.conn === conn).length, 1, "a stalled reader is dropped");
});
