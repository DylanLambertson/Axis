// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_STRING_CHARS, Redactor, isWellFormedString } from "@axis/audit";
import { canary } from "../testing/git-fixture.js";
import { MAX_KEY_FORM_CHARS, holdsRegisteredSecret, providerRedactor, windowBounds } from "../src/bindings/provider-redactor.js";

// The providers' secret check on strings longer than the redactor reads (C7): a long clean tool result is not a secret, and a
// secret anywhere in a long string still is.

const prose = (chars: number): string => {
  const line = "The build step printed one more ordinary line of output.\n";
  return line.repeat(Math.ceil(chars / line.length)).slice(0, chars);
};

test("a clean string longer than the redactor reads is not a secret", () => {
  const p = providerRedactor(new Redactor());
  for (const n of [MAX_STRING_CHARS, MAX_STRING_CHARS + 1, 40 * 1024, 262_144]) assert.equal(p.containsSecret(prose(n)), false, `${n} chars`);
});

test("a pattern secret anywhere in a long string is found: start, middle, end and across every window boundary", () => {
  const p = providerRedactor(new Redactor());
  const secret = ` ${canary(41)} `; // the rule wants a word boundary on each side
  const body = prose(40 * 1024);
  for (const at of [0, 16_000, 20_000, body.length]) assert.equal(p.containsSecret(body.slice(0, at) + secret + body.slice(at)), true, `at ${at}`);
  for (let at = 4094 - secret.length; at < body.length; at += 4094) {
    for (const d of [-1, 0, 1]) assert.equal(p.containsSecret(body.slice(0, at + d) + secret + body.slice(at + d)), true, `at ${at + d}`);
  }
});

test("a registered key of the longest length is found wherever it lies in a long string", () => {
  const r = new Redactor();
  const key = "k".repeat(64) + "q".repeat(4096 - 64); // the longest key the vault holds
  r.registerSecret(key);
  const p = providerRedactor(r);
  const body = prose(48 * 1024);
  for (let at = 0; at <= body.length; at += 1531) {
    const text = body.slice(0, at) + key + body.slice(at);
    assert.equal(p.containsSecret(text), true, `at ${at}`);
    assert.equal(holdsRegisteredSecret(r, text), true, `registered at ${at}`);
  }
});

test("surrogate pairs at window edges are not a change; a lone surrogate in a long string still is", () => {
  const p = providerRedactor(new Redactor());
  const emoji = "\u{1F600}".repeat(30_000);
  assert.equal(p.containsSecret(emoji), false);
  assert.equal(p.containsSecret(`x${emoji}`), false, "pairs shifted by one");
  assert.equal(p.containsSecret(`${prose(30_000)}\ud800${prose(30)}`), true);
});

test("the windows cover the text, each fits the redactor, none splits a pair, and neighbours overlap by a whole key form", () => {
  for (const text of [prose(100_000), `y${"\u{1F600}".repeat(20_000)}`, "\u{1F600}".repeat(20_000)]) {
    let prevEnd = 0;
    let first = true;
    for (const [start, end] of windowBounds(text)) {
      assert.ok(end - start <= MAX_STRING_CHARS && end > start);
      assert.ok(start <= prevEnd, "no gap");
      if (!first) assert.ok(prevEnd - start >= MAX_KEY_FORM_CHARS, "overlap");
      assert.ok(isWellFormedString(text.slice(start, end)), "no pair split");
      prevEnd = end;
      first = false;
    }
    assert.equal(prevEnd, text.length, "the end is covered");
  }
});
