// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { request } from "node:http";
import { connect } from "node:net";
import { test } from "node:test";
import { AxisError } from "@axis/audit";
import { CLOSE, startWebHost } from "../src/web/index.js";
import { ChannelMux } from "../src/index.js";
import { memoryChannelPair } from "../testing/memory-channel.js";
import { fakeClock } from "./helpers.js";
import { ORIGIN, clientFrame, closeCodeOf, manualFlow, memoryRig, rawUpgrade, until, upgradeHeaders } from "./web-helpers.js";

/** The web host over a real loopback socket, with the daemon side in memory (`memoryRig`). */

test("web host: an accepted socket gets 101 with axis.v1 only and reaches the daemon with a web attestation the verifier accepts", async () => {
  const rig = await memoryRig();
  try {
    const c = await rawUpgrade(rig.host.address.port, upgradeHeaders(rig.host.address.port, rig.token));
    assert.equal(c.status, 101);
    assert.equal(c.headers["sec-websocket-protocol"], "axis.v1", "the token is never echoed");
    assert.equal(c.headers["sec-websocket-extensions"], undefined, "no extension is negotiated");
    c.send(clientFrame(1, JSON.stringify({ op: "echo", v: 7 })));
    const f = await c.next();
    assert.equal(f.opcode, 1);
    assert.deepEqual(JSON.parse(f.payload.toString("utf8")), { echo: { op: "echo", v: 7 }, actor: "user", clientKind: "web", windowId: "web", trusted: false });
    const [entry] = [...rig.daemon.values()];
    assert.equal(entry?.identity.actorId, "web-user");
    assert.equal(entry?.identity.workspaceId, undefined);
    assert.ok(/^[A-Za-z0-9_-]{24}$/.test(entry?.identity.connectionId ?? ""));
    assert.equal(rig.host.stats().sessions, 1);
    c.socket.destroy();
  } finally {
    await rig.dispose();
  }
});

test("web host: browser data can never become a control message (it arrives as a frame of its own connection)", async () => {
  const rig = await memoryRig();
  try {
    const c = await rawUpgrade(rig.host.address.port, upgradeHeaders(rig.host.address.port, rig.token));
    const before = rig.control.length;
    for (const m of [{ type: "shutdown" }, { type: "connect", cid: "aaaaaaaaaaaa", attestation: {} }, { kind: "close", cid: "x".repeat(22) }]) {
      c.send(clientFrame(1, JSON.stringify(m)));
      const f = await c.next();
      assert.deepEqual(JSON.parse(f.payload.toString("utf8")).echo, m);
    }
    assert.equal(rig.control.length, before, "no control message reached the daemon");
    c.socket.destroy();
  } finally {
    await rig.dispose();
  }
});

test("web host: refused upgrades get a status with no body, open no connection and send no connect", async () => {
  const rig = await memoryRig();
  const { port } = rig.host.address;
  const wrong = `${rig.token[0] === "A" ? "B" : "A"}${rig.token.slice(1)}`;
  const cases: Array<[string, Record<string, string | undefined>, number, string?]> = [
    ["wrong token", upgradeHeaders(port, wrong), 403],
    ["no token", upgradeHeaders(port, rig.token, { "sec-websocket-protocol": "axis.v1" }), 403],
    ["cross-site origin", upgradeHeaders(port, rig.token, { origin: "http://evil.example" }), 403],
    ["no origin", upgradeHeaders(port, rig.token, { origin: undefined }), 403],
    ["rebound host name", upgradeHeaders(port, rig.token, { host: `evil.example:${port}` }), 403],
    ["token in the query", upgradeHeaders(port, rig.token), 404, `GET /axis/1?token=${rig.token} HTTP/1.1`],
    ["other path", upgradeHeaders(port, rig.token), 404, "GET / HTTP/1.1"],
  ];
  try {
    for (const [name, headers, status, line] of cases) {
      const c = await rawUpgrade(port, headers, line);
      assert.equal(c.status, status, name);
      assert.equal(c.headers["content-length"], "0", name);
      await c.ended;
    }
    assert.equal(rig.supMux.stats().opened, 0);
    assert.equal(rig.control.length, 0);
    const s = rig.host.stats();
    assert.equal(s.refused.bad_token, 1);
    assert.equal(s.refused.bad_protocol, 1);
    assert.equal(s.refused.bad_origin, 2);
    assert.equal(s.refused.bad_host, 1);
    assert.equal(s.refused.bad_path, 2);
    const plain = await new Promise<number>((resolve, reject) => {
      const r = request({ host: "127.0.0.1", port, path: "/", headers: { origin: ORIGIN } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      r.on("error", reject);
      r.end();
    });
    assert.equal(plain, 404, "plain HTTP serves nothing");
    const text = JSON.stringify(rig.events);
    assert.ok(!text.includes(rig.token) && !text.includes(wrong) && !text.includes("evil"), "no header value or token is logged");
  } finally {
    await rig.dispose();
  }
});

test("web host: the token is handed out once", async () => {
  const rig = await memoryRig();
  try {
    assert.throws(() => rig.host.takeToken(), (e: unknown) => e instanceof AxisError && e.code === "E_CONFLICT");
  } finally {
    await rig.dispose();
  }
});

test("web host: maxClients is enforced before the upgrade and a slot is freed when a session ends", async () => {
  const rig = await memoryRig({ config: { limits: { maxClients: 1 } } });
  const { port } = rig.host.address;
  try {
    const first = await rawUpgrade(port, upgradeHeaders(port, rig.token));
    assert.equal(first.status, 101);
    const second = await rawUpgrade(port, upgradeHeaders(port, rig.token));
    assert.equal(second.status, 503);
    assert.equal(rig.host.stats().refused.too_many_clients, 1);
    first.send(clientFrame(8, Buffer.from([0x03, 0xe8])));
    assert.equal(closeCodeOf(await first.next()), CLOSE.normal, "a close is answered");
    await until(() => rig.host.stats().sessions === 0);
    const third = await rawUpgrade(port, upgradeHeaders(port, rig.token));
    assert.equal(third.status, 101);
    third.socket.destroy();
  } finally {
    await rig.dispose();
  }
});

test("web host: protocol errors close the one session with a closed code and close its daemon connection", async () => {
  const rig = await memoryRig({ config: { limits: { maxFrameBytes: 1024 } } });
  const { port } = rig.host.address;
  const cases: Array<[string, Buffer, number]> = [
    ["oversize", clientFrame(1, "x".repeat(2048)), CLOSE.tooBig],
    ["binary", clientFrame(2, "x"), CLOSE.unsupported],
    ["unmasked", clientFrame(1, "{}", { mask: false }), CLOSE.protocol],
    ["not JSON", clientFrame(1, "{"), CLOSE.invalidData],
    ["forbidden key", clientFrame(1, '{"__proto__":{"x":1}}'), CLOSE.policy],
  ];
  try {
    for (const [name, frame, code] of cases) {
      const c = await rawUpgrade(port, upgradeHeaders(port, rig.token));
      await until(() => rig.daemon.size > 0 && [...rig.daemon.values()].some((d) => !d.closed));
      c.send(frame);
      assert.equal(closeCodeOf(await c.next()), code, name);
      await c.ended;
      await until(() => [...rig.daemon.values()].every((d) => d.closed));
      assert.ok([...rig.daemon.values()].every((d) => d.received.length === 0), `${name}: nothing reached the daemon`);
    }
    assert.equal(rig.host.stats().sessions, 0);
  } finally {
    await rig.dispose();
  }
});

test("web host: an attestation the daemon refuses ends the session", async () => {
  const rig = await memoryRig({ key: Buffer.alloc(32, 7) });
  const { port } = rig.host.address;
  try {
    const c = await rawUpgrade(port, upgradeHeaders(port, rig.token));
    assert.equal(closeCodeOf(await c.next()), CLOSE.normal);
    assert.equal(rig.daemon.size, 0);
    await until(() => rig.host.stats().sessions === 0);
  } finally {
    await rig.dispose();
  }
});

test("web host: while the channel backlog is at its bound no session reads; a drain resumes them in order", async () => {
  const rig = await memoryRig({ config: { limits: { maxChannelBacklog: 2 } } });
  const { port } = rig.host.address;
  try {
    const c = await rawUpgrade(port, upgradeHeaders(port, rig.token));
    await until(() => rig.daemon.size === 1);
    const d = [...rig.daemon.values()][0];
    rig.flow.set(2);
    c.send(clientFrame(1, '{"n":1}'));
    await until(() => rig.host.stats().paused);
    c.send(clientFrame(1, '{"n":2}'));
    c.send(clientFrame(1, '{"n":3}'));
    // A full HTTP round trip on the same event loop: had the socket been read, the frames would be in by now.
    await new Promise<void>((resolve) => request({ host: "127.0.0.1", port, path: "/" }, (res) => res.resume().on("end", resolve)).end());
    await until(() => (d?.received.length ?? 0) >= 1);
    assert.deepEqual(d?.received, [{ n: 1 }]);
    rig.flow.drain();
    await until(() => (d?.received.length ?? 0) === 3);
    assert.deepEqual(d?.received, [{ n: 1 }, { n: 2 }, { n: 3 }]);
    assert.equal(rig.host.stats().paused, false);
    c.socket.destroy();
  } finally {
    await rig.dispose();
  }
});

test("web host: a browser that does not read is cut off once its unsent bytes pass the bound", async () => {
  const rig = await memoryRig({ config: { limits: { maxOutboundBytes: 65_536 } }, echo: false });
  const { port } = rig.host.address;
  try {
    const c = await rawUpgrade(port, upgradeHeaders(port, rig.token));
    c.socket.pause();
    await until(() => rig.daemon.size === 1);
    const d = [...rig.daemon.values()][0];
    const part = "z".repeat(200_000);
    for (let i = 0; i < 64 && d?.closed !== true; i++) d?.conn.send({ parts: [part, part, part, part], i });
    await until(() => d?.closed === true);
    assert.equal(rig.host.stats().closed[String(CLOSE.tryAgain)], 1);
    c.socket.destroy();
  } finally {
    await rig.dispose();
  }
});

test("web host: the channel closing ends every session with 1001 and later upgrades get 503", async () => {
  const rig = await memoryRig();
  const { port } = rig.host.address;
  try {
    const c = await rawUpgrade(port, upgradeHeaders(port, rig.token));
    await until(() => rig.daemon.size === 1);
    rig.supEnd.close();
    assert.equal(closeCodeOf(await c.next()), CLOSE.goingAway);
    const late = await rawUpgrade(port, upgradeHeaders(port, rig.token));
    assert.equal(late.status, 503);
  } finally {
    await rig.dispose();
  }
});

test("web host: dispose closes sessions with 1001, stops listening and removes its channel listeners", async () => {
  const rig = await memoryRig();
  const { port } = rig.host.address;
  const c = await rawUpgrade(port, upgradeHeaders(port, rig.token));
  await until(() => rig.daemon.size === 1);
  await rig.host.dispose();
  assert.equal(closeCodeOf(await c.next()), CLOSE.goingAway);
  await c.ended;
  assert.equal(rig.flow.listeners(), 0);
  const refused = await new Promise<string>((resolve) => {
    const s = connect({ host: "127.0.0.1", port });
    s.on("error", (e: NodeJS.ErrnoException) => resolve(e.code ?? "error"));
    s.on("connect", () => {
      s.destroy();
      resolve("connected");
    });
  });
  assert.equal(refused, "ECONNREFUSED");
  await until(() => [...rig.daemon.values()].every((d) => d.closed));
  await rig.dispose();
});

test("web host: a short key, an unparsed or default config and a non-loopback bind start nothing", async () => {
  const { a } = memoryChannelPair();
  const mux = new ChannelMux(a);
  const base = { mux, flow: manualFlow(), clock: fakeClock(), attestationKey: Buffer.alloc(32, 1) };
  try {
    for (const config of [undefined, {}, { enabled: false, port: 0, allowedOrigins: [ORIGIN] }, { enabled: true, host: "0.0.0.0", port: 0, allowedOrigins: [ORIGIN] }]) {
      await assert.rejects(startWebHost({ ...base, config }), (e: unknown) => e instanceof AxisError && e.detail["reason"] === "web_config_invalid");
    }
    await assert.rejects(startWebHost({ ...base, attestationKey: Buffer.alloc(16), config: { enabled: true, port: 0, allowedOrigins: [ORIGIN] } }), (e: unknown) => e instanceof AxisError && e.detail["reason"] === "web_key_invalid");
  } finally {
    mux.dispose();
  }
});

test("web host: a port already in use fails closed with a closed reason", async () => {
  const rig = await memoryRig();
  try {
    const { a } = memoryChannelPair();
    const mux = new ChannelMux(a);
    await assert.rejects(
      startWebHost({ mux, flow: manualFlow(), clock: fakeClock(), attestationKey: Buffer.alloc(32, 1), config: { enabled: true, port: rig.host.address.port, allowedOrigins: [ORIGIN] } }),
      (e: unknown) => e instanceof AxisError && e.detail["reason"] === "listen_failed",
    );
    mux.dispose();
  } finally {
    await rig.dispose();
  }
});

test("web host: a peer that resets while the host writes its close frame raises no uncaught error", async () => {
  const rig = await memoryRig();
  const { port } = rig.host.address;
  const c = await rawUpgrade(port, upgradeHeaders(port, rig.token));
  await until(() => rig.daemon.size === 1);
  c.socket.resetAndDestroy();
  await rig.host.dispose();
  // Let the reset's write error surface (an unhandled one would fail this test as an uncaught exception).
  await until(() => [...rig.daemon.values()].every((d) => d.closed));
  for (let i = 0; i < 50; i++) await new Promise<void>((r) => setImmediate(r));
  await rig.dispose();
});
