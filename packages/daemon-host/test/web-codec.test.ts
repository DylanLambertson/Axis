// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CLOSE, FrameDecoder, WsProtocolError, encodeClose, encodeText } from "../src/web/ws-codec.js";
import { clientFrame, serverFrames } from "./web-helpers.js";

const code = (fn: () => unknown): number => {
  try {
    fn();
  } catch (e) {
    if (e instanceof WsProtocolError) return e.closeCode;
    throw e;
  }
  return 0;
};

test("codec: masked text frames decode, split across chunks and several in one chunk", () => {
  const d = new FrameDecoder(1024);
  const a = clientFrame(1, '{"a":1}');
  const b = clientFrame(1, "héllo");
  assert.deepEqual(d.push(a.subarray(0, 3)), []);
  assert.deepEqual(d.push(Buffer.concat([a.subarray(3), b])), [{ kind: "text", text: '{"a":1}' }, { kind: "text", text: "héllo" }]);
  assert.equal(d.buffered, 0);
  const big = "x".repeat(300);
  assert.deepEqual(new FrameDecoder(1024).push(clientFrame(1, big)), [{ kind: "text", text: big }]);
});

test("codec: unmasked frames and RSV bits are protocol errors (no extension is negotiated)", () => {
  assert.equal(code(() => new FrameDecoder(1024).push(clientFrame(1, "x", { mask: false }))), CLOSE.protocol);
  for (const rsv of [1, 2, 4]) assert.equal(code(() => new FrameDecoder(1024).push(clientFrame(1, "x", { rsv }))), CLOSE.protocol, `rsv ${rsv}`);
});

test("codec: binary, fragments and continuations are refused as unsupported; unknown opcodes as protocol errors", () => {
  assert.equal(code(() => new FrameDecoder(1024).push(clientFrame(2, "x"))), CLOSE.unsupported);
  assert.equal(code(() => new FrameDecoder(1024).push(clientFrame(1, "x", { fin: false }))), CLOSE.unsupported);
  assert.equal(code(() => new FrameDecoder(1024).push(clientFrame(0, "x"))), CLOSE.unsupported);
  for (const op of [3, 7, 0xb, 0xf]) assert.equal(code(() => new FrameDecoder(1024).push(clientFrame(op, "x"))), CLOSE.protocol, `opcode ${op}`);
});

test("codec: an oversize frame is refused from its header alone, before any payload is buffered", () => {
  const frame = clientFrame(1, "x".repeat(2000));
  const d = new FrameDecoder(1024);
  assert.equal(code(() => d.push(frame.subarray(0, 4))), CLOSE.tooBig);
  assert.deepEqual(d.push(frame.subarray(4)), [], "nothing is accepted after a refusal");
  assert.equal(d.buffered, 0);
  assert.equal(new FrameDecoder(2000).push(frame).length, 1, "at the limit it passes");
});

test("codec: control frames must be final and at most 125 bytes; lengths must be minimal; 64-bit lengths may not set the top bit", () => {
  assert.equal(code(() => new FrameDecoder(1024).push(clientFrame(9, "x", { fin: false }))), CLOSE.protocol);
  assert.equal(code(() => new FrameDecoder(1024).push(clientFrame(9, "x".repeat(126)))), CLOSE.protocol);
  assert.equal(code(() => new FrameDecoder(1024).push(clientFrame(1, "x", { len: "16" }))), CLOSE.protocol);
  assert.equal(code(() => new FrameDecoder(1 << 20).push(clientFrame(1, "x".repeat(200), { len: "64" }))), CLOSE.protocol);
  const huge = Buffer.from([0x81, 0xff, 0x80, 0, 0, 0, 0, 0, 0, 1]);
  assert.equal(code(() => new FrameDecoder(1024).push(huge)), CLOSE.protocol);
  assert.equal(code(() => new FrameDecoder(1024).push(clientFrame(8, Buffer.from([3])))), CLOSE.protocol, "a 1-byte close payload");
});

test("codec: invalid UTF-8 is 1007; ping, pong and close are reported; nothing after close", () => {
  assert.equal(code(() => new FrameDecoder(1024).push(clientFrame(1, Buffer.from([0xc3, 0x28])))), CLOSE.invalidData);
  const d = new FrameDecoder(1024);
  const frames = d.push(Buffer.concat([clientFrame(9, "hi"), clientFrame(0xa, ""), clientFrame(8, Buffer.from([0x03, 0xe8])), clientFrame(1, "after")]));
  assert.deepEqual(frames.map((f) => f.kind), ["ping", "pong", "close"]);
  assert.equal((frames[0] as { payload: Buffer }).payload.toString(), "hi");
  assert.deepEqual(d.push(clientFrame(1, "more")), []);
});

test("codec: server frames are unmasked, use the shortest length and carry a close code with no reason", () => {
  for (const n of [0, 125, 126, 65_535, 65_536]) {
    const f = encodeText("y".repeat(n));
    assert.equal(((f[1] as number) & 0x80), 0, "unmasked");
    const { frames } = serverFrames(f);
    assert.equal(frames[0]?.payload.length, n);
  }
  const c = encodeClose(CLOSE.tooBig);
  assert.deepEqual([...c], [0x88, 2, 0x03, 0xf1]);
});

test("codec: a large frame arriving one byte at a time is joined once, not on every chunk", () => {
  const frame = clientFrame(1, JSON.stringify({ s: "q".repeat(70_000) }));
  const d = new FrameDecoder(1 << 20);
  const real = Buffer.concat;
  let calls = 0;
  Buffer.concat = ((list: readonly Uint8Array[], total?: number) => {
    calls++;
    return real(list, total);
  }) as typeof Buffer.concat;
  let frames;
  try {
    for (let i = 0; i < frame.length - 1; i++) assert.deepEqual(d.push(frame.subarray(i, i + 1)), []);
    frames = d.push(frame.subarray(frame.length - 1));
  } finally {
    Buffer.concat = real;
  }
  assert.equal(frames.length, 1);
  assert.equal(d.buffered, 0);
  assert.ok(calls <= 4, `joined ${calls} times`);
});
