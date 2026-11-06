// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { adaptMessagePort } from "../src/index.js";
import { settle, until } from "../testing/helpers.js";
import { nodePair, nodeShaped, RecordingPort } from "../testing/ports.js";

test("messages cross a real MessagePort both ways, and closing one end closes the other end's channel", async () => {
  const { a, b } = nodePair();
  const x = adaptMessagePort(nodeShaped(a), { shape: "node" });
  const y = adaptMessagePort(nodeShaped(b), { shape: "node" });
  const got: unknown[] = [];
  let closes = 0;
  y.onMessage((m) => void got.push(m));
  y.onClose(() => void closes++);
  x.send({ hello: 1 });
  await until(() => got.length === 1);
  assert.deepEqual(got, [{ hello: 1 }]);
  x.close();
  await until(() => closes === 1);
  assert.throws(() => y.send({}), /closed/);
  assert.throws(() => x.send({}), /closed/);
});

test("the close listeners run once however many ways the channel ends, and a late close listener runs at once", () => {
  const port = new RecordingPort();
  const ch = adaptMessagePort(port, { shape: "node" });
  let n = 0;
  ch.onClose(() => void n++);
  port.fireClose();
  port.fireClose();
  ch.close();
  assert.equal(n, 1);
  assert.equal(port.closes, 0, "the port's own close event does not close it a second time");
  ch.onClose(() => void n++);
  assert.equal(n, 2);
});

test("close() closes the port once, removes both listeners and drops later messages", () => {
  const port = new RecordingPort();
  const ch = adaptMessagePort(port, { shape: "node" });
  const got: unknown[] = [];
  ch.onMessage((m) => void got.push(m));
  port.deliver("a");
  ch.close();
  ch.close();
  assert.deepEqual(got, ["a"]);
  assert.equal(port.closes, 1);
  assert.equal(port.message.size, 0);
  assert.equal(port.closeL.size, 0);
});

test("closeOn synthesises the close a utility process's parent port lacks, and is undone when the channel ends", () => {
  const port = new RecordingPort();
  let fire: () => void = () => undefined;
  let undone = 0;
  const ch = adaptMessagePort(port, { shape: "electron", closeOn: (f) => ((fire = f), { dispose: () => void undone++ }) });
  let closed = 0;
  ch.onClose(() => void closed++);
  fire();
  assert.equal(closed, 1);
  assert.equal(port.closes, 1);
  assert.equal(undone, 1);
  assert.throws(() => ch.send(1), /closed/);
});

test("electron shape: only event.data is delivered, a message carrying ports is dropped and every port closed", () => {
  const port = new RecordingPort();
  const ch = adaptMessagePort(port, { shape: "electron" });
  const got: unknown[] = [];
  ch.onMessage((m) => void got.push(m));
  const extra = [new RecordingPort(), new RecordingPort()];
  port.deliver({ data: { t: "x" }, ports: [] });
  port.deliver({ data: { t: "smuggled" }, ports: extra });
  port.deliver(null);
  assert.deepEqual(got, [{ t: "x" }, undefined]);
  assert.deepEqual(extra.map((p) => p.closes), [1, 1]);
});

test("a throwing listener does not stop the others, and the port is started", async () => {
  const port = new RecordingPort();
  let started = 0;
  (port as { start?: () => void }).start = () => void started++;
  const ch = adaptMessagePort(port, { shape: "node" });
  const got: unknown[] = [];
  ch.onMessage(() => { throw new Error("boom"); });
  ch.onMessage((m) => void got.push(m));
  port.deliver("z");
  await settle(1);
  assert.deepEqual(got, ["z"]);
  assert.equal(started, 1);
});
