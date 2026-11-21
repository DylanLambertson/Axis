// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// PV-X1b (docs/design/pty-exec-node.md §6.3 and §6.4): one new control channel to both processes whenever either (re)starts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ControlHandover, PTY_CONTROL_MESSAGE, type HandoverChild } from "../src/main/pty-handover.js";

interface Port { readonly id: string; closed: boolean }

class Child implements HandoverChild {
  readonly got: { message: unknown; ports: string[] }[] = [];
  fail = false;
  constructor(readonly name: string) {}
  postMessage(message: unknown, transfer?: readonly unknown[]): void {
    if (this.fail) throw new Error("child gone");
    this.got.push({ message, ports: (transfer ?? []).map((p) => (p as Port).id) });
  }
}

function rig() {
  let n = 0;
  const ports: Port[] = [];
  const events: string[] = [];
  const h = new ControlHandover<Port>({
    createChannel: () => {
      n++;
      const port1 = { id: `${n}a`, closed: false };
      const port2 = { id: `${n}b`, closed: false };
      ports.push(port1, port2);
      return { port1, port2 };
    },
    closePort: (p) => {
      p.closed = true;
    },
    onEvent: (e, f) => events.push(`${e}${f.side === undefined ? "" : `:${f.side}`}${f.count === undefined ? "" : `#${f.count}`}`),
  });
  return { h, ports, events };
}

test("nothing is handed over until both are up; then one channel, port A to the pty process and port B to the daemon", () => {
  const { h, ports, events } = rig();
  const pty = new Child("pty");
  const daemon = new Child("daemon");
  h.pty(pty, true);
  assert.equal(ports.length, 0, "the daemon is not up yet");
  h.daemon(daemon, true);
  assert.deepEqual(pty.got, [{ message: { type: "pty-control" }, ports: ["1a"] }]);
  assert.deepEqual(daemon.got, [{ message: { type: "pty-control" }, ports: ["1b"] }]);
  assert.deepEqual(Object.keys(pty.got[0]!.message as object), ["type"], "exactly one key");
  assert.notEqual(pty.got[0]!.message, PTY_CONTROL_MESSAGE, "a fresh object each time, never the frozen constant");
  assert.equal(h.count(), 1);
  assert.deepEqual(events, ["handed_over#1"]);
  assert.ok(ports.every((p) => !p.closed), "posted ports belong to the receivers");
});

test("a pty restart hands BOTH a new channel; so does a daemon restart; an old port is never sent again", () => {
  const { h } = rig();
  const pty1 = new Child("pty1");
  const daemon1 = new Child("daemon1");
  h.daemon(daemon1, true);
  h.pty(pty1, true);
  h.pty(pty1, false);
  const pty2 = new Child("pty2");
  h.pty(pty2, true);
  assert.deepEqual(daemon1.got.map((g) => g.ports), [["1b"], ["2b"]], "the daemon replaces its port");
  assert.deepEqual(pty2.got.map((g) => g.ports), [["2a"]]);
  h.daemon(daemon1, false);
  const daemon2 = new Child("daemon2");
  h.daemon(daemon2, true);
  assert.deepEqual(pty2.got.map((g) => g.ports), [["2a"], ["3a"]]);
  assert.deepEqual(daemon2.got.map((g) => g.ports), [["3b"]]);
  assert.deepEqual(pty1.got.map((g) => g.ports), [["1a"]], "the exited pty process gets nothing more");
  assert.equal(h.count(), 3);
});

test("while one side is down nothing is posted to the other", () => {
  const { h, ports } = rig();
  const pty = new Child("pty");
  const daemon = new Child("daemon");
  h.pty(pty, true);
  h.daemon(daemon, true);
  h.pty(pty, false);
  h.daemon(daemon, false);
  h.daemon(daemon, true);
  assert.equal(ports.length, 2, "the pty process is down: no channel");
  assert.equal(daemon.got.length, 1);
});

test("a late exit of an older child never removes its successor", () => {
  const { h } = rig();
  const old = new Child("old");
  const fresh = new Child("fresh");
  const daemon = new Child("daemon");
  h.pty(old, true);
  h.pty(fresh, true);
  h.pty(old, false);
  h.daemon(daemon, true);
  assert.deepEqual(fresh.got.map((g) => g.ports), [["1a"]], "the successor still gets the channel");
});

test("a post that fails closes every port not posted; a port already posted is the receiver's", () => {
  const first = rig();
  const pty = new Child("pty");
  pty.fail = true;
  first.h.pty(pty, true);
  first.h.daemon(new Child("daemon"), true);
  assert.deepEqual(first.ports.map((p) => p.closed), [true, true]);
  assert.deepEqual(first.events, ["post_failed:pty"]);
  assert.equal(first.h.count(), 0);

  const second = rig();
  const daemon = new Child("daemon");
  daemon.fail = true;
  const okPty = new Child("pty");
  second.h.pty(okPty, true);
  second.h.daemon(daemon, true);
  assert.deepEqual(second.ports.map((p) => p.closed), [false, true], "port A went to the pty process; port B is closed here");
  assert.deepEqual(second.events, ["post_failed:daemon"]);
});

test("after dispose nothing is handed over", () => {
  const { h, ports } = rig();
  h.dispose();
  h.pty(new Child("pty"), true);
  h.daemon(new Child("daemon"), true);
  assert.equal(ports.length, 0);
});
