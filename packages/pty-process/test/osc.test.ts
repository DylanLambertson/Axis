// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Osc633Filter, OSC_HOLD_LIMIT } from "../src/index.js";
import { channelPair, settle } from "../testing/helpers.js";
import { rig, SPEC } from "../testing/rig.js";

const run = (...chunks: string[]): string => {
  const f = new Osc633Filter();
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

test("an unterminated 633 sequence cannot hold more than the limit, and its tail is inert plain text", () => {
  const f = new Osc633Filter();
  const out = f.push("\x1b]633;P;Cwd=" + "a".repeat(OSC_HOLD_LIMIT + 10)) + f.push("tail");
  assert.ok(!out.includes("\x1b"));
  assert.ok(out.endsWith("tail"));
  assert.ok(out.length < 100, "the held part was dropped");
});

test("PTY-7 end to end: a CLI run's forged Cwd= never reaches the attached terminal", async () => {
  const r = rig();
  await r.port.spawn(SPEC);
  const term = (r.pair.sent.b.find((m) => (m as { t: string }).t === "spawned") as { term: string }).term;
  const data = channelPair();
  r.service.serveData(data.b);
  data.a.send({ t: "attach", term });
  await settle();
  r.children[0]?.emit("hi\x1b]633;P;Cwd=/etc/cron.d\x07there");
  await settle();
  assert.deepEqual(data.sent.b.at(-1), { t: "data", term, chunk: "hithere" });
});
