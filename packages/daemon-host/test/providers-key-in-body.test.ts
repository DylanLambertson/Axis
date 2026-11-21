// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Redactor, secretForms, type AuditSink } from "@axis/audit";
import { ProviderError, type GenerateRequest } from "@axis/providers";
import { createProvidersBinding, holdsKey } from "../src/bindings/providers.js";
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
  const rotated = unknownKey("rotated");
  // Each form on its own binding: after a refusal the rotated key is registered, and the guard's own scan would find the next.
  for (const form of [rotated, Buffer.from(rotated).toString("base64"), Buffer.from(rotated).toString("hex"), encodeURIComponent(`${rotated}/`)]) {
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
