// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { ENDPOINT_HOST_LIMITS, PtySpawnError, createEndpointHost, endpointDirOk, isEndpointPath, type EndpointHost, type RelayInbound } from "../src/index.js";
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
function host(t: TestContext): Host {
  const sent: RelayInbound[] = [];
  const clock = new DelayClock();
  const d = dir(t);
  const h = createEndpointHost({ dir: d, platform: process.platform, uid }, { send: (m) => (sent.push(m), true), clock, random: counterRandom() });
  t.after(() => h.closeAll());
  return { host: h, sent, clock, dir: d };
}

const frame = (body: string | Buffer, declared?: number): Buffer => {
  const b = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  const head = Buffer.alloc(4);
  head.writeUInt32BE(declared ?? b.length, 0);
  return Buffer.concat([head, b]);
};
async function dial(path: string): Promise<Socket & { ended: Promise<void>; got: Buffer[] }> {
  const s = connect(path) as Socket & { ended: Promise<void>; got: Buffer[] };
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
