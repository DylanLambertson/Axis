// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { OscCwdFilter, OSC_HOLD_LIMIT } from "../src/index.js";
import { channelPair, settle } from "../testing/helpers.js";
import { rig, SPEC } from "../testing/rig.js";

const run = (...chunks: string[]): string => {
  const f = new OscCwdFilter();
  return chunks.map((c) => f.push(c)).join("");
};

test("PTY-7: OSC 633 Cwd= is removed with BEL and ST terminators", () => {
  assert.equal(run("a\x1b]633;P;Cwd=/etc\x07b"), "ab");
  assert.equal(run("a\x1b]633;P;Cwd=/etc\x1b\\b"), "ab");
  assert.equal(run("a\u009d633;P;Cwd=/etc\u009cb"), "ab");
  assert.equal(run("\x1b]633;A\x07"), "");
});

test("PTY-7: a sequence split across chunks (even byte by byte) is removed", () => {
  const s = "x\x1b]633;P;Cwd=/etc\x07y";
  assert.equal(run(...s.split("")), "xy");
  assert.equal(run("x\x1b", "]633;P;Cw", "d=/etc\x1b", "\\y"), "xy");
});

test("other OSC sequences and plain text pass through unchanged, terminators kept", () => {
  const s = "\x1b]0;title\x07 \x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\ \x1b[31mred\x1b[0m 63 3";
  assert.equal(run(s), s);
  assert.equal(run(...s.split("")), s);
  assert.equal(run("\x1b]6330;x\x07"), "\x1b]6330;x\x07", "6330 is not 633");
  assert.equal(run("a\x1bb"), "a\x1bb");
});

test("an unterminated sequence with a huge id cannot hold more than the limit: it is dropped, not printed", () => {
  const f = new OscCwdFilter();
  const out = f.push("\x1b]" + "0".repeat(OSC_HOLD_LIMIT + 10) + "633;P;Cwd=/evil") + f.push("\x07tail");
  assert.equal(out, "tail");
});

test("S1: OSC 7, 9, 133 and 1337 (which Code OSS also reads a cwd or marks from) are removed; titles and links are not", () => {
  assert.equal(run("a\x1b]7;file:///etc/cron.d\x07b"), "ab");
  assert.equal(run("a\x1b]9;9;/etc\x1b\\b"), "ab");
  assert.equal(run("a\x1b]133;A\x07b"), "ab");
  assert.equal(run("a\x1b]1337;CurrentDir=/etc\x07b"), "ab");
  assert.equal(run("a\u009d7;file:///etc\u009cb"), "ab");
  assert.equal(run("a\x1b]7\x07b"), "ab", "an id without a payload");
  assert.equal(run("\x1b]8;;https://example.com\x07x\x1b]0;t\x07"), "\x1b]8;;https://example.com\x07x\x1b]0;t\x07");
  assert.equal(run("\x1b]77;x\x07\x1b]1338;x\x07\x1b]13;x\x07"), "\x1b]77;x\x07\x1b]1338;x\x07\x1b]13;x\x07", "neighbouring ids are not denied");
});

test("PTY-7 end to end: a CLI run's forged Cwd= never reaches the attached terminal", async () => {
  const r = rig();
  const term = (await r.port.spawn(SPEC)).terminalId;
  const data = channelPair();
  r.service.serveData(data.b, "c1");
  r.port.grant(term, "c1");
  await settle();
  data.a.send({ t: "attach", term });
  await settle();
  r.children[0]?.emit("hi\x1b]633;P;Cwd=/etc/cron.d\x07there");
  await settle();
  assert.deepEqual(data.sent.b.at(-1), { t: "data", term, chunk: "hithere" });
});
