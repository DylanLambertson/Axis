// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { RETRYABLE_CODES, errorSchema } from "@axis/protocol";
import {
  MOCK_DEFAULT_MODEL,
  PROVIDER_ERROR_CODES,
  ProviderError,
  REDACTED,
  StreamValidator,
  axisCodeFor,
  codeForHttpStatus,
  collectStream,
  createMockProvider,
  createRunBudget,
  createSecretRedactor,
  isRetryableCode,
  toAxisError,
  validateRequest,
  type StreamEvent,
} from "../src/index.js";

test("errors: every code maps to a valid bridge error with consistent retryability", () => {
  for (const code of PROVIDER_ERROR_CODES) {
    const e = new ProviderError(code, { status: 503, retryAfterMs: 1_500, reason: "tokens" });
    const axis = toAxisError(e, "corr-1");
    assert.equal(errorSchema.safeParse(axis).success, true, code);
    assert.equal(axis.code, axisCodeFor(code));
    assert.equal(axis.retryable, RETRYABLE_CODES.has(axis.code), code);
    assert.equal(isRetryableCode(code), axis.retryable, `${code}: provider and bridge agree on retry`);
    assert.equal(axis.details?.["providerCode"], code);
  }
});

test("errors: details are sanitized and there is no cause", () => {
  const e = new ProviderError("rate_limited", { status: 99, retryAfterMs: -1, reason: "Has Spaces", capability: "x".repeat(100) });
  assert.deepEqual(e.details, {});
  assert.equal("cause" in e, false);
  assert.equal(new ProviderError("rate_limited", { retryAfterMs: 1e12 }).details.retryAfterMs, 86_400_000);
  assert.deepEqual(Object.keys(e.toJSON()).sort(), ["code", "details", "message", "name", "retryable"]);
});

test("errors: HTTP status mapping", () => {
  const cases: Array<[number, string]> = [
    [400, "invalid_request"], [401, "authentication"], [403, "permission_denied"], [404, "not_found"],
    [408, "timeout"], [413, "context_length_exceeded"], [429, "rate_limited"], [500, "server_error"],
    [503, "overloaded"], [529, "overloaded"], [302, "invalid_response"], [200, "invalid_response"],
  ];
  for (const [status, code] of cases) assert.equal(codeForHttpStatus(status), code, String(status));
});

test("validateRequest: error messages name the path, never the value", () => {
  try {
    validateRequest({ model: "m", messages: [{ role: "user", content: [{ type: "text", text: 42 as never }] }], maxOutputTokens: 1 });
    assert.fail("expected failure");
  } catch (e) {
    assert.ok(e instanceof ProviderError);
    assert.equal(e.code, "invalid_request");
    assert.match(e.message, /messages\.0\.content\.0\.text/);
  }
  assert.throws(
    () => validateRequest({ model: "m", messages: [{ role: "user", content: [{ type: "text", text: "a" }] }], maxOutputTokens: 1, providerOptions: { "<script>": () => 1 } as never }),
    (e: unknown) => e instanceof ProviderError && !e.message.includes("<script>"),
  );
  // Hostile JSON inside tool input is refused by the bounded JSON walk.
  const evil = JSON.parse('{"__proto__": {"polluted": true}}') as never;
  assert.throws(() =>
    validateRequest({
      model: "m",
      messages: [{ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "x", input: evil }] }],
      maxOutputTokens: 1,
    }),
  );
});

function events(...evs: unknown[]): StreamEvent[] {
  return evs as StreamEvent[];
}

const start = { type: "message_start", model: "m" };
const stop = { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };

test("StreamValidator: rejects grammar violations with a fixed reason", () => {
  const cases: Array<[string, unknown[]]> = [
    ["missing_message_start", [{ type: "content_block_start", index: 0, block: { type: "text" } }]],
    ["duplicate_message_start", [start, start]],
    ["block_index_order", [start, { type: "content_block_start", index: 1, block: { type: "text" } }]],
    ["delta_type_mismatch", [start, { type: "content_block_start", index: 0, block: { type: "text" } }, { type: "content_block_delta", index: 0, delta: { type: "tool_input", partialJson: "{}" } }]],
    ["unclosed_block", [start, { type: "content_block_start", index: 0, block: { type: "text" } }, stop]],
    ["tool_use_stop_without_tool", [start, { ...stop, stopReason: "tool_use" }]],
    ["event_after_stop", [start, stop, stop]],
    ["usage_decreased", [start, { type: "usage", usage: { inputTokens: 5, outputTokens: 5 } }, stop]],
    ["malformed_event", [start, { type: "ping" }]],
    ["malformed_event", [start, { type: "content_block_start", index: 0, block: { type: "text" }, extra: 1 }]],
    ["tool_input_not_json", [start, { type: "content_block_start", index: 0, block: { type: "tool_use", id: "a", name: "b" } }, { type: "content_block_delta", index: 0, delta: { type: "tool_input", partialJson: "{oops" } }, { type: "content_block_stop", index: 0 }]],
  ];
  for (const [reason, evs] of cases) {
    const v = new StreamValidator();
    assert.throws(
      () => { for (const e of evs) v.accept(e); },
      (e: unknown) => e instanceof ProviderError && e.code === "invalid_response" && e.details.reason === reason,
      reason,
    );
  }
});

test("StreamValidator: limits on events and tool input", () => {
  const v = new StreamValidator({ maxEvents: 2 });
  v.accept(start);
  v.accept({ type: "usage", usage: { inputTokens: 1, outputTokens: 0 } });
  assert.throws(() => v.accept(stop), /malformed|limit/);
  const w = new StreamValidator({ maxToolInputChars: 4 });
  w.accept(start);
  w.accept({ type: "content_block_start", index: 0, block: { type: "tool_use", id: "a", name: "b" } });
  assert.throws(() => w.accept({ type: "content_block_delta", index: 0, delta: { type: "tool_input", partialJson: '{"a":1}' } }));
});

test("collectStream: assembles text and tool input from deltas", async () => {
  async function* gen() {
    yield* events(
      start,
      { type: "content_block_start", index: 0, block: { type: "text" } },
      { type: "content_block_delta", index: 0, delta: { type: "text", text: "he" } },
      { type: "content_block_delta", index: 0, delta: { type: "text", text: "llo" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, block: { type: "tool_use", id: "t1", name: "read" } },
      { type: "content_block_delta", index: 1, delta: { type: "tool_input", partialJson: '{"pa' } },
      { type: "content_block_delta", index: 1, delta: { type: "tool_input", partialJson: 'th":"a"}' } },
      { type: "content_block_stop", index: 1 },
      { ...stop, stopReason: "tool_use" },
    );
  }
  const r = await collectStream(gen());
  assert.deepEqual(r.content, [
    { type: "text", text: "hello" },
    { type: "tool_use", id: "t1", name: "read", input: { path: "a" } },
  ]);
});

test("redactor: exact, encoded and pattern matches; short secrets ignored; longest first", () => {
  const secret = "canary-credential-value/with+chars";
  const r = createSecretRedactor({
    secrets: () => [secret, "canary-credential", "short"],
    patterns: [/demo-prefix-[a-z]{6,}/],
  });
  assert.equal(r.redact(`a ${secret} b`), `a ${REDACTED} b`);
  assert.equal(r.redact(encodeURIComponent(secret)), REDACTED);
  assert.equal(r.redact(JSON.stringify({ k: 'q"canary-credential' })), `{"k":"q\\"${REDACTED}"}`);
  assert.equal(r.redact("short stays"), "short stays");
  assert.equal(r.redact("x demo-prefix-abcdefgh y demo-prefix-zzzzzzz"), `x ${REDACTED} y ${REDACTED}`);
  assert.equal(r.containsSecret("demo-prefix-abcdefgh"), true);
  assert.equal(r.containsSecret("demo-prefix-abcdefgh"), true, "pattern state does not leak between calls");
  assert.equal(r.containsSecret("nothing here"), false);
});

test("redactor: reads the live secret set (rotation)", () => {
  let current = ["first-secret-value"];
  const r = createSecretRedactor({ secrets: () => current });
  assert.equal(r.containsSecret("first-secret-value"), true);
  current = ["second-secret-value"];
  assert.equal(r.containsSecret("first-secret-value"), false);
  assert.equal(r.containsSecret("second-secret-value"), true);
});

test("budget: refuses bad limits and resumes from journal state", () => {
  assert.throws(() => createRunBudget({ maxTokens: -1 }), RangeError);
  assert.throws(() => createRunBudget({ maxTokens: 1.5 }), RangeError);
  const b = createRunBudget({ maxTokens: 100 }, { tokens: 100 });
  const d = b.beforeRequest({ runId: "r", providerId: "p", connectionId: "c", model: "m", maxOutputTokens: 10, costKnown: true });
  assert.deepEqual(d, { allow: false, reason: "tokens" });
});

test("mock: echoes by default, plays replies in order and records requests", async () => {
  const mock = createMockProvider({ replies: [{ kind: "text", text: "first" }] });
  const opts = { signal: new AbortController().signal };
  const r = { model: MOCK_DEFAULT_MODEL, messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "ping" }] }], maxOutputTokens: 10 };
  assert.equal((await mock.generate(r, opts)).content[0]?.type, "text");
  const second = await mock.generate(r, opts);
  assert.deepEqual(second.content, [{ type: "text", text: "Mock reply: ping" }]);
  mock.enqueue({ kind: "text", text: "queued" });
  assert.deepEqual((await mock.generate(r, opts)).content, [{ type: "text", text: "queued" }]);
  assert.equal(mock.requests.length, 3);
  assert.equal(mock.descriptor.destination.origin, undefined, "the mock declares no network destination");
});

test("mock: chunking never splits a surrogate pair", async () => {
  const text = "a😀b😀c😀";
  const mock = createMockProvider({ replies: [{ kind: "text", text }], chunkChars: 2 });
  const deltas: string[] = [];
  for await (const e of mock.stream({ model: MOCK_DEFAULT_MODEL, messages: [{ role: "user", content: [{ type: "text", text: "x" }] }], maxOutputTokens: 10 }, { signal: new AbortController().signal })) {
    if (e.type === "content_block_delta" && e.delta.type === "text") deltas.push(e.delta.text);
  }
  assert.equal(deltas.join(""), text);
  for (const d of deltas) assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(d));
});
