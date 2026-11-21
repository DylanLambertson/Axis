// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CREDENTIAL, failure, live, make, req } from "./support/harness.js";
import { sseResponse, textReply } from "./support/transport.js";

// C7-F4: the key just read is checked against the request it would go out with, after the read and before `fetch`.

const ok = (_c: unknown, counter: Parameters<Parameters<typeof make>[0]>[1]) => sseResponse(counter, textReply("ok"));
const MARKER = "carries-the-key-marker";
const posts = <T extends { init: { method?: string } }>(calls: readonly T[]): T[] => calls.filter((c) => c.init.method === "POST");

test("holdsKey is asked after the key is read, with the request's path and body, and the very key that would be sent", async () => {
  let reads = 0;
  const asked: Array<{ text: string; key: string; readsSoFar: number }> = [];
  const { adapter, fake } = make(ok, { apiKey: () => (reads++, CREDENTIAL), holdsKey: (text, key) => (asked.push({ text, key, readsSoFar: reads }), false) });
  await adapter.generate(req(), { signal: live() });
  const post = posts(fake.calls)[0];
  assert.ok(post !== undefined);
  assert.ok(asked.every((a) => a.key === CREDENTIAL));
  // Each request's check comes after that request's own key read: the model lookup (1 read), then the message (2 reads).
  const body = asked.find((a) => a.text === post.init.body);
  assert.ok(body !== undefined, "the body that was sent is the body that was checked");
  assert.equal(body.readsSoFar, reads, "after the message's key read");
  assert.ok(asked.some((a) => a.text.startsWith("/v1/messages")), "the path too");
});

test("a request that holds the key is refused secret_in_request and never sent; a check that throws refuses too", async () => {
  for (const holdsKey of [(text: string) => text.includes(MARKER), (text: string) => (text.includes(MARKER) ? (() => { throw new Error("boom"); })() : false)]) {
    const { adapter, fake } = make(ok, { holdsKey });
    const err = await failure(adapter.generate(req({ messages: [{ role: "user", content: [{ type: "text", text: `here ${MARKER}` }] }] }), { signal: live() }));
    assert.equal(err.code, "secret_in_request");
    assert.equal(posts(fake.calls).length, 0, "the message was not sent");
  }
});

test("without a hit the body goes out unchanged", async () => {
  const { adapter, fake } = make(ok, { holdsKey: () => false });
  await adapter.generate(req(), { signal: live() });
  const { adapter: plain, fake: plainFake } = make(ok);
  await plain.generate(req(), { signal: live() });
  assert.equal(posts(fake.calls)[0]?.init.body, posts(plainFake.calls)[0]?.init.body);
});

test("count_tokens goes through the same check: a body holding the key is refused and not sent", async () => {
  const { adapter, fake } = make(ok, { holdsKey: (text) => text.includes(MARKER) });
  const err = await failure(adapter.countTokens?.(req({ messages: [{ role: "user", content: [{ type: "text", text: `here ${MARKER}` }] }] }), { signal: live() }) ?? Promise.resolve());
  assert.equal(err.code, "secret_in_request");
  assert.equal(posts(fake.calls).length, 0, "the count request was not sent");
});
