// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The two echo scans (net-read-slice.md §4.2): the raw headers and body, then every key and string of a parsed tree.
import { test } from "node:test";
import assert from "node:assert/strict";
import { secretForms } from "@axis/audit";
import { echoInParsed, echoInRaw, echoNeedles } from "../../src/integrations/echo.js";

const TOKEN = String.raw`canary"T0k3n\x+y/z=Q9w-synthetic-0001`;
const HEADER = `Bearer ${TOKEN}`;
const n = echoNeedles(HEADER, TOKEN);
const body = (s: string): Buffer => Buffer.from(s, "utf8");

test("the needles are every secretForms form of the header value and of the token", () => {
  assert.deepEqual([...n.text].sort(), [...new Set([...secretForms(HEADER), ...secretForms(TOKEN)])].sort());
  assert.equal(n.bytes.length, n.text.length);
});

test("the first scan finds each listed form in a body, a header value or a header name, and nothing in a clean response", () => {
  assert.equal(echoInRaw({ "content-type": "application/json" }, body('{"a":"clean"}'), n), false);
  for (const form of n.text) {
    assert.equal(echoInRaw({}, body(`{"x":"${form}"}`), n), true, `body: ${form}`);
    assert.equal(echoInRaw({ "x-echo": form }, body("{}"), n), true, `header: ${form}`);
    assert.equal(echoInRaw({ "x-many": ["a", form] }, body("{}"), n), true, `repeated header: ${form}`);
  }
  assert.equal(echoInRaw({ [`x-${Buffer.from(TOKEN).toString("hex")}`]: "1" }, body("{}"), n), true, "a header name");
});

test("the first scan reads the body as bytes too: a token next to invalid UTF-8 is still found", () => {
  const raw = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(TOKEN), Buffer.from([0xc3])]);
  assert.equal(echoInRaw({}, raw, n), true);
  const sub = raw.subarray(1);
  assert.equal(echoInRaw({}, new Uint8Array(sub.buffer, sub.byteOffset, sub.byteLength), n), true, "a view at an offset");
});

test("the first scan misses a fully unicode-escaped token; the second scan finds it after the parse", () => {
  const escaped = [...TOKEN].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
  const raw = `{"body":"${escaped}"}`;
  assert.equal(echoInRaw({}, body(raw), n), false);
  assert.equal(echoInParsed(JSON.parse(raw), n), true);
});

test("the second scan walks keys and strings at any depth, and nothing else", () => {
  let deep: unknown = TOKEN;
  for (let i = 0; i < 10_000; i++) deep = [deep];
  assert.equal(echoInParsed(deep, n), true, "deep, without exhausting the stack");
  assert.equal(echoInParsed({ a: { [TOKEN]: 1 } }, n), true, "a key");
  assert.equal(echoInParsed({ a: [1, true, null, { b: "clean" }] }, n), false);
  assert.equal(echoInParsed(42, n), false);
});
