// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Redactor, secretForms, type AuditSink } from "@axis/audit";
import { ProviderError, type GenerateRequest } from "@axis/providers";
import { base64Middles, createProvidersBinding, holdsKey } from "../src/bindings/providers.js";
import { fakeBackend, mockAnthropic, MODEL } from "./anthropic-server.js";

// C7-F4 (docs/design/composer-outgoing-scan.md): a provider key is never sent inside its own request body, also when the key is
// new to this process at the send (rotated in the keyring while the model's capabilities are cached, so the guard's scan ran
// before the adapter read it).

const CONN = "anthropic-main";
/** A credential no built-in redaction rule knows: only its registration can hide it (so the guard's scan cannot find it). */
const unknownKey = (tag: string): string => ["holdout", tag, "credential", "c7f4"].join("~");
const audit: AuditSink = { append: () => undefined } as unknown as AuditSink;
const ask = (text: string): GenerateRequest => ({ model: MODEL, messages: [{ role: "user", content: [{ type: "text", text }] }], maxOutputTokens: 64 });
const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "sent";
  } catch (e) {
    return e instanceof ProviderError ? e.code : String(e);
  }
};

async function rig() {
  const api = await mockAnthropic();
  const old = unknownKey("before");
  const backend = fakeBackend(CONN, old);
  const redactor = new Redactor();
  const b = createProvidersBinding({ redactor, audit, anthropic: { connectionId: CONN, backend, fetch: api.fetch } });
  const provider = b.providers[0];
  assert.ok(provider !== undefined);
  const messages = () => api.seen.filter((s) => s.path === "/v1/messages");
  return { api, backend, redactor, provider, messages, old };
}

test("a key rotated in the keyring and held in the request is refused at the send: the body that would carry it never reaches fetch", async () => {
  // `>` and `?` put sextets 62 and 63 in its base64 at every offset, so base64url (with `-` and `_`) differs from base64
  // where it matters (review c7-f4 r3).
  const rotated = unknownKey(">?>?rotated");
  // Each form on its own binding: after a refusal the rotated key is registered, and the guard's own scan would find the next.
  // base64 and base64url at byte offsets 0, 1 and 2 of a longer run (review c7-f4 r1 SF), with bytes after it too.
  const at = (inner: string, o: number, enc: "base64" | "base64url"): string => Buffer.concat([Buffer.alloc(o, 0x78), Buffer.from(inner), Buffer.from("tail")]).toString(enc);
  const encoded = [0, 1, 2].flatMap((o) => (["base64", "base64url"] as const).map((enc) => at(rotated, o, enc)));
  // One level over another form (review c7-f4 r2 SF): base64 of the key's base64 and of its hex, at each offset.
  const nested = [0, 1, 2].flatMap((o) => [at(Buffer.from(rotated).toString("base64"), o, "base64"), at(Buffer.from(rotated).toString("hex"), o, "base64")]);
  for (const form of [rotated, Buffer.from(rotated).toString("hex"), encodeURIComponent(`${rotated}/`), ...encoded, ...nested]) {
    const r = await rig();
    try {
      r.api.replies = [{ kind: "text", text: "first" }];
      assert.equal(await code(r.provider.generate(ask("hello"), { runId: "r1", signal: new AbortController().signal })), "sent");
      r.backend.setKey(rotated); // the capabilities stay cached: the next request reads the key only inside its send
      r.api.replies = [{ kind: "text", text: "never" }];
      assert.equal(await code(r.provider.generate(ask(`the new key is ${form}`), { runId: "r1", signal: new AbortController().signal })), "secret_in_request", form.slice(0, 12));
      assert.equal(r.messages().length, 1, "no request carrying the rotated key was sent");
      assert.ok(r.api.seen.every((s) => !s.body.includes(form)), "the rotated key is in no body that left");
      r.api.replies = [{ kind: "text", text: "second" }];
      assert.equal(await code(r.provider.generate(ask("hello again"), { runId: "r1", signal: new AbortController().signal })), "sent", "a request without it goes out with the new key");
    } finally {
      await r.api.close();
    }
  }
});

test("holdsKey finds every form the redactor registers, also as it appears inside a JSON body, and nothing else", () => {
  const key = 'ab"c\\d-key-value-0123';
  for (const form of secretForms(key)) {
    assert.equal(holdsKey(`x ${form} y`, key), true, form);
    assert.equal(holdsKey(JSON.stringify({ text: `x ${form} y` }), key), true, `${form} in JSON`);
  }
  assert.equal(holdsKey(JSON.stringify({ text: "an ordinary request body" }), key), false);
  assert.equal(holdsKey(key.slice(0, -1), key), false, "a prefix is not the key");
  const r = new Redactor();
  r.registerSecret(key);
  assert.equal(r.registeredForms, secretForms(key).length, "one list for the redactor and the check");
});

test("holdsKey finds the key in base64 and base64url at every byte offset, with any bytes around it, also inside JSON", () => {
  // Key lengths of every remainder modulo 3, so the key's own last group is whole, one byte short and two bytes short.
  // Key lengths of every remainder modulo 3; the `>?` keys put `+` and `/` in every base64 middle, so their base64url middles
  // (with `-` and `_`) differ from them (review c7-f4 r3: with only the first three, the base64url middles were never needed).
  const differing = ["holdout~>?>?~credential~c7f4", "holdout~>?>?~credential~c7f4x", "holdout~>?>?~credential~c7f4xy"];
  for (const key of differing) {
    const m = base64Middles(key);
    for (let i = 0; i < m.length; i += 2) assert.notEqual(m[i], m[i + 1], `${key}: the alphabets differ at offset ${i / 2}`);
  }
  for (const key of ["holdout~offset~credential~c7f4", "holdout~offset~credential~c7f4x", "holdout~offset~credential~c7f4xy", ...differing])
  for (let before = 0; before <= 5; before++) {
    for (let after = 0; after <= 4; after++) {
      for (const enc of ["base64", "base64url"] as const) {
        const run = Buffer.concat([Buffer.alloc(before, 0x41), Buffer.from(key), Buffer.alloc(after, 0x42)]).toString(enc);
        assert.equal(holdsKey(`x ${run} y`, key), true, `${enc} ${before}/${after}`);
        assert.equal(holdsKey(JSON.stringify({ text: run }), key), true, `${enc} ${before}/${after} in JSON`);
      }
    }
  }
  // An 8-byte text (the shortest registered secret) yields a middle at each of the 3 offsets in both alphabets, each at least
  // 8 characters: every alignment has a needle.
  const shortest = base64Middles("12345678");
  assert.equal(shortest.length, 6);
  assert.ok(shortest.every((m) => m.length >= 8));
  assert.equal(holdsKey(Buffer.from("an unrelated base64 payload of some length").toString("base64"), "holdout~offset~credential~c7f4"), false);
});

test("holdsKey finds base64 one level over any registered form (the key's hex, its base64), at every offset, as the redactor does", () => {
  const key = "holdout~nested~credential~c7f4x";
  const r = new Redactor();
  r.registerSecret(key);
  for (const inner of [Buffer.from(key).toString("hex"), Buffer.from(key).toString("base64"), Buffer.from(key).toString("base64url"), encodeURIComponent(key)]) {
    for (let before = 0; before <= 3; before++) {
      for (const enc of ["base64", "base64url"] as const) {
        const run = Buffer.concat([Buffer.alloc(before, 0x41), Buffer.from(inner), Buffer.alloc(2, 0x42)]).toString(enc);
        assert.equal(holdsKey(`x ${run} y`, key), true, `${enc}(${inner.slice(0, 8)}) at ${before}`);
      }
    }
  }
  // Two levels over the key's base64 (three over the key): the redactor decodes once and does not find it, nor does the
  // check (listed as not found).
  const twice = Buffer.from(Buffer.from(Buffer.from(key).toString("base64")).toString("base64")).toString("base64");
  assert.equal(r.redactString(`x ${twice} y`), `x ${twice} y`);
  assert.equal(holdsKey(`x ${twice} y`, key), false);
});

test("holdsKey finds base64url over every registered form, where the two alphabets differ (review c7-f4 r3)", () => {
  let differing = 0;
  for (const key of ["holdout~>?>?~credential~c7f4", "holdout~>?>?~credential~c7f4x", "holdout~>?>?~credential~c7f4xy"]) {
    for (const form of secretForms(key)) {
      const m = base64Middles(form);
      for (let i = 0; i < m.length; i += 2) if (m[i] !== m[i + 1]) differing++;
      for (let before = 0; before <= 3; before++) {
        for (const enc of ["base64", "base64url"] as const) {
          const run = Buffer.concat([Buffer.alloc(before, 0x41), Buffer.from(form), Buffer.alloc(2, 0x42)]).toString(enc);
          assert.equal(holdsKey(`x ${run} y`, key), true, `${enc}(${form.slice(0, 12)}) at ${before}`);
        }
      }
    }
  }
  // The URL-encoded form (`%3E%3F`) and the raw key give base64 middles with `+` and `/`: base64url is needed for those.
  assert.ok(differing >= 12, `${differing} form middles where the alphabets differ`);
});
