// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_STRING_CHARS, Redactor, isWellFormedString } from "@axis/audit";
import { canary } from "../testing/git-fixture.js";
import { MAX_CLEAN_VERDICTS, MAX_KEY_FORM_CHARS, WINDOW_STEP, holdsRegisteredSecret, providerRedactor, windowBounds, windowCount } from "../src/bindings/provider-redactor.js";

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

/** A redactor that counts the strings it is asked to redact (each long-string window is one). */
class Counting extends Redactor {
  calls = 0;
  override redactString(input: string): string {
    this.calls += 1;
    return super.redactString(input);
  }
}

test("every form of a longest key is found across every window boundary, at 16,384 and at each window step", () => {
  // 4096 characters that URL-encode to three each: the URL-encoded form is exactly MAX_KEY_FORM_CHARS long.
  const key = "/".repeat(4096);
  const buf = Buffer.from(key, "utf8");
  const forms = { raw: key, url: encodeURIComponent(key), base64: buf.toString("base64"), hex: buf.toString("hex") };
  assert.equal(forms.url.length, MAX_KEY_FORM_CHARS, "the URL form is the longest form the windows must hold");
  const r = new Redactor();
  r.registerSecret(key);
  const p = providerRedactor(r);
  const body = prose(36 * 1024); // six windows: the first edge at 16,384 and edges at window steps after it
  const edges = new Set<number>([MAX_STRING_CHARS]);
  for (const [start, end] of windowBounds(body)) edges.add(start).add(end);
  for (const [name, form] of Object.entries(forms)) {
    for (const edge of edges) {
      // The form ending just before, at and after the edge, and starting just before, at and after it: every straddle.
      for (const at of [edge - form.length - 1, edge - form.length, edge - form.length + 1, edge - 1, edge, edge + 1, edge - Math.floor(form.length / 2)]) {
        if (at < 0 || at > body.length) continue;
        const text = body.slice(0, at) + form + body.slice(at);
        assert.equal(p.containsSecret(text), true, `${name} at ${at} (edge ${edge})`);
        if (at === edge) assert.equal(holdsRegisteredSecret(r, text), true, `${name} registered at ${at}`);
      }
    }
  }
  assert.ok(WINDOW_STEP + MAX_KEY_FORM_CHARS + 2 === MAX_STRING_CHARS);
});

test("work bound: a 4 MiB string costs windowCount(length) scans once, nothing on the next request, and again after a new key", () => {
  const r = new Counting();
  const p = providerRedactor(r);
  const big = prose(4 * 1024 * 1024);
  assert.equal(p.containsSecret(big), false);
  assert.equal(r.calls, windowCount(big.length), "one scan per window, no more");
  assert.ok(r.calls <= Math.ceil(big.length / WINDOW_STEP) + 1, "about four reads of each character");
  r.calls = 0;
  assert.equal(p.containsSecret(`${big.slice(0, 10)}${big.slice(10)}`), false, "the same text in a new string");
  assert.equal(r.calls, 0, "a history judged before is not scanned again");
  // A new registered secret makes every kept verdict stale: the text is judged again, and one that holds it is refused.
  const mid = prose(256 * 1024);
  assert.equal(p.containsSecret(mid), false);
  const late = "late-registered-credential-value-0001";
  r.registerSecret(late);
  r.calls = 0;
  assert.equal(p.containsSecret(mid), false);
  assert.equal(r.calls, windowCount(mid.length), "judged again under the new secret");
  const holding = `${mid.slice(0, 200_000)} ${late} ${mid.slice(200_000)}`;
  assert.equal(p.containsSecret(holding), true);
  assert.equal(p.containsSecret(holding), true, "a secret verdict is never kept as clean");
});

test("the kept verdicts are bounded, and one a string never earned is not taken", () => {
  const r = new Counting();
  const p = providerRedactor(r, 2);
  const texts = [1, 2, 3].map((n) => `${n}${prose(20_000)}`);
  for (const t of texts) p.containsSecret(t);
  r.calls = 0;
  p.containsSecret(texts[0] as string);
  assert.equal(r.calls, windowCount(20_001), "the oldest verdict was dropped");
  r.calls = 0;
  p.containsSecret(texts[2] as string);
  assert.equal(r.calls, 0, "a kept one is used");
  assert.ok(MAX_CLEAN_VERDICTS >= 64);
  const secret = ` ${canary(43)} `;
  const withSecret = `${texts[1]}${secret}`;
  assert.equal(p.containsSecret(withSecret), true, "a different text does not share a clean verdict");
});

test("a text with a lone surrogate never takes the clean verdict of its replacement-character twin", () => {
  const p = providerRedactor(new Redactor());
  const twin = `${prose(30_000)}�${prose(30)}`;
  assert.equal(p.containsSecret(twin), false, "U+FFFD is ordinary text");
  // UTF-8 encodes a lone surrogate as U+FFFD, so both would hash alike: the check before the kept verdicts tells them apart.
  assert.equal(p.containsSecret(`${prose(30_000)}\ud800${prose(30)}`), true);
});
