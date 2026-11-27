// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { Server, connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { listenOnPath, type EndpointConn } from "../src/endpoint-listen.js";

// The endpoint template (the one pty-process file that may load node:net, pinned by SHA-256 in scripts/code-oss/web-rules.mjs):
// a listen on an absolute Unix socket path only, the server and the raw sockets kept inside, over real sockets.

const posix = process.platform !== "win32";
const skip = posix ? undefined : "Unix sockets: Windows has no messaging endpoint until the native pipe helper exists";

/** Count every Server.listen call while the test runs (the spy calls through). */
function spyListen(t: TestContext): unknown[][] {
  const calls: unknown[][] = [];
  const original = Server.prototype.listen;
  Server.prototype.listen = function (this: Server, ...args: unknown[]) {
    calls.push(args);
    return original.apply(this, args as never);
  } as typeof original;
  t.after(() => void (Server.prototype.listen = original));
  return calls;
}
function socketPath(t: TestContext): string {
  const base = mkdtempSync(join(tmpdir(), "axl-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return join(base, "e.sock");
}

test("gate line: a relative or numeric path is refused before anything listens (a numeric string would be a TCP port)", async (t) => {
  const calls = spyListen(t);
  for (const p of ["8080", " 8080 ", "0", "relative.sock", "./a.sock", ""]) {
    // A listener that did start is closed at once, so a missing guard fails here by name instead of holding the process open.
    const outcome = await listenOnPath(p, () => undefined).then(
      (h) => (h.close(), "listened"),
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    );
    assert.equal(outcome, "not an absolute socket path", JSON.stringify(p));
  }
  assert.deepEqual(calls, [], "listen was never called");
});

test("an absolute path: listen is called exactly once, with that path; data flows through the facade; close removes the socket", { skip }, async (t) => {
  const calls = spyListen(t);
  const path = socketPath(t);
  const conns: EndpointConn[] = [];
  const got: Uint8Array[] = [];
  const handle = await listenOnPath(path, (c) => {
    conns.push(c);
    c.onData((d) => {
      got.push(d);
      c.write(Buffer.from("pong"));
    });
  });
  t.after(() => handle.close());
  assert.deepEqual(calls.map((a) => a[0]), [path], "one listen, on the path");
  assert.deepEqual(Object.keys(handle), ["close"]);
  assert.ok(Object.isFrozen(handle));
  const s = connect(path);
  t.after(() => s.destroy());
  const reply = await new Promise<string>((res, rej) => {
    s.once("error", rej);
    s.once("data", (d) => res(d.toString()));
    s.write("ping");
  });
  assert.equal(reply, "pong");
  assert.equal(Buffer.concat(got).toString(), "ping");
  handle.close();
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(existsSync(path), false, "the socket file goes with the listener");
});

test("the connection facade: frozen, exactly seven closures, and neither the socket nor the server is reachable through it", { skip }, async (t) => {
  const path = socketPath(t);
  let conn: EndpointConn | undefined;
  const handle = await listenOnPath(path, (c) => void (conn = c));
  t.after(() => handle.close());
  const s = connect(path);
  t.after(() => s.destroy());
  for (let i = 0; i < 200 && conn === undefined; i++) await new Promise((res) => setTimeout(res, 5));
  assert.ok(conn !== undefined, "connected");
  assert.deepEqual(Object.keys(conn).sort(), ["buffered", "destroy", "end", "onClose", "onData", "onError", "write"]);
  assert.equal(conn.buffered(), 0, "buffered() is a number (the bytes not yet taken by the peer)");
  assert.ok(Object.isFrozen(conn));
  for (const key of ["server", "_server", "_handle", "connect", "socket", "remoteAddress", "address"]) assert.equal(key in conn, false, key);
  assert.equal(Object.getPrototypeOf(conn), Object.prototype, "a plain object, not a socket");
  for (const f of Object.values(conn)) assert.equal(typeof f, "function");
  const closed = new Promise<void>((res) => conn?.onClose(() => res()));
  conn.destroy();
  await closed;
});
