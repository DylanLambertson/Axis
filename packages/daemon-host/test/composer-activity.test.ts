// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_ACTIVITY_TEXT, REFUSED_ACTIVITY } from "@axis/protocol";
import { RunActivity, activityTexts } from "../src/index.js";

// Review r1 S3: the activity store's memory bounds and the text split, tested rather than read.

const meta = { mode: "ask" as const, providerId: "mock", modelId: "m" };
const state = { type: "state" as const, state: "RUNNING" as const, reason: null };

test("activityTexts: every piece is at most the wire limit, escapes and astral characters are never split, nothing is lost", () => {
  const raw = `${"a".repeat(MAX_ACTIVITY_TEXT - 3)}‮😀\u0000${"😀".repeat(3000)}​`;
  const pieces = activityTexts(raw);
  assert.ok(pieces.length >= 2);
  for (const p of pieces) {
    assert.ok(p.length >= 1 && p.length <= MAX_ACTIVITY_TEXT, `piece of ${p.length}`);
    assert.equal(REFUSED_ACTIVITY.test(p), false);
    assert.equal(/[\ud800-\udbff]$/.test(p), false, "no piece ends inside a surrogate pair");
  }
  const joined = pieces.join("");
  assert.equal(joined, raw.replace(/‮/g, "\\u{202e}").replace(/\u0000/g, "\\u{0}").replace(/​/g, "\\u{200b}"));
  assert.ok(!pieces[0]?.endsWith("\\u{20"), "an escape is never cut");
  assert.deepEqual(activityTexts(""), []);
});

test("RunActivity: at most maxEvents per run, the oldest go first, and a reader keeps going from what is left", () => {
  const a = new RunActivity(() => 0, { maxEvents: 3 });
  a.open("r", meta);
  for (let i = 0; i < 5; i++) a.push("r", state);
  const page = a.read("r", 0, 10);
  assert.deepEqual(page.events.map((e) => e.seq), [3, 4, 5]);
  assert.deepEqual(a.read("r", 4, 10).events.map((e) => e.seq), [5]);
});

test("RunActivity: model text is bounded per run in characters; usage survives eviction", () => {
  const a = new RunActivity(() => 0, { maxTextChars: 10_000 });
  a.open("r", meta);
  a.push("r", { type: "usage", usage: { inputTokens: 1, outputTokens: 2, requests: 1 } });
  for (let i = 0; i < 5; i++) a.push("r", { type: "text", text: "x".repeat(4000) });
  const texts = a.read("r", 0, 200).events.filter((e) => e.type === "text");
  assert.ok(texts.reduce((n, e) => n + (e.type === "text" ? e.text.length : 0), 0) <= 10_000);
  assert.equal(texts.length, 2);
  assert.deepEqual(a.usage("r"), { inputTokens: 1, outputTokens: 2, requests: 1 }, "the usage is kept after its event left the ring");
});

test("RunActivity: at most maxRuns runs are kept; the oldest finished goes first and a live run is never evicted", () => {
  const a = new RunActivity(() => 0, { maxRuns: 2 });
  a.open("live", meta);
  a.open("done", meta);
  a.close("done");
  a.open("new", meta);
  assert.equal(a.read("done", 0, 10).available, false, "the finished run was evicted");
  assert.equal(a.read("live", 0, 10).available, true, "the live run was kept");
  a.open("newer", meta);
  assert.equal(a.read("live", 0, 10).available, true, "still kept: nothing finished to evict");
  a.push("done", state);
  assert.equal(a.read("done", 0, 10).available, false, "an evicted run gains nothing");
});
