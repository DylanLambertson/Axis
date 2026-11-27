// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createEndpointHost, relayOutbound, type RelayInbound } from "../src/index.js";
import { counterRandom } from "../testing/helpers.js";

// PV-M6 slice 3, pty side: a pause drops every connection of an endpoint (open and lingering) and keeps its listener; a
// revocation still removes everything. Real Unix sockets; Windows has no endpoint, so these are skipped by name there.

const skip = process.platform === "win32" ? "Unix sockets: Windows has no messaging endpoint until the native pipe helper exists" : undefined;
const EP = `ep_${"A".repeat(43)}`;
const EP2 = `ep_${"B".repeat(43)}`;

/** A clock whose timers never fire on their own: a linger timer stays until the test or the host clears it. */
function clock() {
  const timers = new Map<number, number>();
  let next = 1;
  return {
    timers,
    setTimeout: (_fn: () => void, ms: number): unknown => (timers.set(next, ms), next++),
    clearTimeout: (id: unknown): void => void timers.delete(id as number),
  };
}

function rig(t: TestContext) {
  const base = mkdtempSync(join(tmpdir(), "axep-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const sent: RelayInbound[] = [];
  const c = clock();
  const host = createEndpointHost({ dir: join(base, "d"), platform: process.platform, uid: process.getuid?.() ?? -1 }, { send: (m) => (sent.push(m), true), clock: c, random: counterRandom() });
  t.after(() => host.closeAll());
  const frame = (o: unknown): Buffer => {
    const b = Buffer.from(JSON.stringify(o), "utf8");
    const h = Buffer.alloc(4);
    h.writeUInt32BE(b.length, 0);
    return Buffer.concat([h, b]);
  };
  const until = async (pred: () => boolean, what: string): Promise<void> => {
    for (let i = 0; i < 400; i++) {
      if (pred()) return;
      await new Promise((res) => setTimeout(res, 5));
    }
    assert.fail(`${what} not reached`);
  };
  /** A connected client the host has answered `auth` for; `gone` settles when its socket closes. */
  const authed = async (endpoint: string, path: string, allowHalfOpen = false): Promise<{ s: Socket; conn: string; gone: Promise<void> }> => {
    const opens = sent.filter((m) => m.t === "relay-open").length;
    const s = connect({ path, allowHalfOpen });
    s.on("error", () => undefined);
    s.resume(); // it reads, so it sees the host's end and closes
    t.after(() => s.destroy());
    const gone = new Promise<void>((res) => s.once("close", () => res()));
    await until(() => sent.filter((m) => m.t === "relay-open").length === opens + 1, "opened");
    const conn = (sent.filter((m) => m.t === "relay-open").at(-1) as { conn: string }).conn;
    s.write(frame({ op: "auth", token: "T".repeat(43) }));
    await until(() => sent.some((m) => m.t === "relay-frame" && m.conn === conn), "the auth relayed");
    host.onRelay({ t: "relay-reply", endpoint, conn, frame: "{}", close: false, authFailed: false });
    return { s, conn, gone };
  };
  /** True when `p` settles within the bound (fails by name, never hangs). */
  const within = (p: Promise<unknown>, ms = 3000): Promise<boolean> => Promise.race([p.then(() => true), new Promise<boolean>((res) => setTimeout(() => res(false), ms).unref())]);
  return { host, sent, clock: c, authed, within, frame };
}

test("PV-M6 slice 3: endpoint-drop closes every connection of that endpoint, lingering ones too, and keeps the listener and the other endpoints", { skip }, async (t) => {
  const r = rig(t);
  const path = (await r.host.open(EP)) as string;
  const other = (await r.host.open(EP2)) as string;
  const a = await r.authed(EP, path);
  const b = await r.authed(EP, path);
  const l = await r.authed(EP, path, true); // half-open: it stays open after the host ends it, so only a destroy closes it
  r.host.onRelay({ t: "relay-reply", endpoint: EP, conn: l.conn, frame: '{"ok":false}', close: true, authFailed: false });
  assert.equal([...r.clock.timers.values()].filter((ms) => ms === 5000).length, 1, "one lingering connection");
  const o = await r.authed(EP2, other);
  r.host.onRelay({ t: "endpoint-drop", endpoint: EP, reason: "paused" });
  assert.deepEqual([await r.within(a.gone), await r.within(b.gone)], [true, true], "the open connections were closed");
  assert.deepEqual(r.sent.filter((m) => m.t === "relay-close" && m.endpoint === EP).map((m) => (m as { conn: string }).conn).sort(), [a.conn, b.conn, l.conn].sort(), "relay-close for each");
  assert.equal([...r.clock.timers.values()].filter((ms) => ms === 5000).length, 0, "the lingering connection was destroyed with its timer");
  let lingerGone = false;
  void l.gone.then(() => (lingerGone = true));
  for (let i = 0; i < 100 && !lingerGone; i++) (l.s.write(r.frame({ op: "read" })), await new Promise((res) => setTimeout(res, 10)));
  assert.equal(lingerGone, true, "the lingering socket itself is gone");
  assert.equal(await r.within(o.gone, 200), false, "the other endpoint's connection stays");
  assert.ok(existsSync(path), "the listener's socket file stays");
  const again = await r.authed(EP, path);
  assert.ok(again.conn.length > 0, "a new connection is accepted after the drop");
});

test("PV-M6 slice 3: a revocation after a pause still removes the endpoint entirely; the reason enums are exact", { skip }, async (t) => {
  const r = rig(t);
  const path = (await r.host.open(EP)) as string;
  const a = await r.authed(EP, path);
  r.host.onRelay({ t: "endpoint-drop", endpoint: EP, reason: "paused" });
  assert.equal(await r.within(a.gone), true);
  r.host.onRelay({ t: "endpoint-close", endpoint: EP, reason: "revoked" });
  assert.equal(existsSync(path), false, "the socket file is gone");
  assert.equal(relayOutbound.safeParse({ t: "endpoint-drop", endpoint: EP, reason: "paused" }).success, true);
  assert.equal(relayOutbound.safeParse({ t: "endpoint-close", endpoint: EP, reason: "paused" }).success, false, "pause never closes the endpoint");
  assert.equal(relayOutbound.safeParse({ t: "endpoint-drop", endpoint: EP, reason: "revoked" }).success, false);
});

test("review s3 N3: endpoint-drop for an endpoint this host does not hold changes nothing", { skip }, async (t) => {
  const r = rig(t);
  const path = (await r.host.open(EP)) as string;
  const a = await r.authed(EP, path);
  const before = r.sent.length;
  r.host.onRelay({ t: "endpoint-drop", endpoint: EP2, reason: "paused" });
  assert.equal(await r.within(a.gone, 200), false, "the held endpoint's connection stays");
  assert.equal(r.sent.length, before, "nothing relayed");
  assert.ok(existsSync(path));
});
