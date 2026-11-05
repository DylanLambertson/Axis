// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Capabilities, cost, token counting, model listing, request mapping and the
// HTTP error table.
import { test } from "node:test";
import assert from "node:assert/strict";
import { codeForStatus, createAnthropicAdapter, parseRetryAfter, priceUsage } from "../src/index.js";
import { MODEL } from "./support/scenarios.js";
import { CREDENTIAL, failure, live, make, req } from "./support/harness.js";
import { fakeFetch, jsonResponse, modelInfo, response, sseResponse, textReply, type Handler } from "./support/transport.js";

const ok: Handler = (_c, counter) => sseResponse(counter, textReply("ok"));
const posts = (calls: ReturnType<typeof make>["fake"]["calls"]) => calls.filter((c) => c.init.method === "POST");

// ------------------------------------------------------------ capabilities

test("capabilities come from the models response, not from the model name", async () => {
  for (const [image, want] of [[true, "supported"], [false, "unsupported"], [undefined, "unknown"]] as const) {
    const info = modelInfo("m", image === undefined ? { capabilities: {} } : { capabilities: { image_input: { supported: image } } });
    const { adapter } = make((_c, counter) => jsonResponse(counter, 200, info));
    const caps = await adapter.getCapabilities("m", { signal: live() });
    assert.equal(caps.features.imageInput, want);
    assert.equal(caps.modelId, "m");
    assert.equal(caps.providerApiVersion, "2023-06-01");
    assert.equal(caps.features.streaming, "supported");
    assert.equal(caps.features.toolUse, "supported");
    assert.equal(caps.features.temperature, "unknown");
    assert.equal(caps.features.toolChoice, "unknown");
    assert.equal(caps.features.reasoning, "unsupported");
    assert.deepEqual(caps.limits, { contextWindowTokens: 200_000, maxOutputTokens: 64_000 });
  }
});

test("limits are taken only when they are positive integers; junk fields are ignored", async () => {
  const { adapter } = make((_c, counter) => jsonResponse(counter, 200, { id: "m", max_input_tokens: -5, max_tokens: "lots", capabilities: "nope", extra: { deep: [1, 2] } }));
  const caps = await adapter.getCapabilities("m", { signal: live() });
  assert.deepEqual(caps.limits, {});
  assert.equal(caps.features.imageInput, "unknown");
});

test("a model that does not exist is not_found; a hostile id sends nothing; unusual ids are encoded", async () => {
  const { adapter, fake } = make((_c, counter) => jsonResponse(counter, 404, { type: "error", error: { type: "not_found_error", message: "x" } }));
  assert.equal((await failure(adapter.getCapabilities("nope", { signal: live() }))).code, "not_found");
  assert.equal((await failure(adapter.getCapabilities("has space", { signal: live() }))).code, "invalid_request");
  assert.equal((await failure(adapter.getCapabilities("", { signal: live() }))).code, "invalid_request");
  await adapter.getCapabilities("a/b?c#d", { signal: live() }).catch(() => undefined);
  await adapter.getCapabilities("../../v1/organizations", { signal: live() }).catch(() => undefined);
  const urls = fake.calls.map((c) => c.url);
  assert.ok(urls.includes("https://api.anthropic.com/v1/models/a%2Fb%3Fc%23d"));
  assert.ok(urls.includes("https://api.anthropic.com/v1/models/..%2F..%2Fv1%2Forganizations"));
  assert.equal(urls.length, 3, "the two invalid ids never reached the wire");
});

test("capabilities are cached for ten minutes and failures are not cached", async () => {
  let clock = 1_000;
  let fail = true;
  const { adapter, fake } = make((_c, counter) => (fail ? jsonResponse(counter, 500, {}) : jsonResponse(counter, 200, modelInfo("m"))), { now: () => clock });
  await failure(adapter.getCapabilities("m", { signal: live() }));
  fail = false;
  await adapter.getCapabilities("m", { signal: live() });
  await adapter.getCapabilities("m", { signal: live() });
  assert.equal(fake.calls.length, 2, "one failure, one success, then a cache hit");
  clock += 600_001;
  await adapter.getCapabilities("m", { signal: live() });
  assert.equal(fake.calls.length, 3);
});

test("features the model does not report as supported are refused before anything is sent", async () => {
  const { adapter, fake } = make(ok);
  const refusals: Array<[Parameters<typeof req>[0], string]> = [
    [{ temperature: 0.5 }, "temperature"],
    [{ toolChoice: "any", tools: [{ name: "t", description: "d", inputSchema: { type: "object" } }] }, "toolChoice"],
    [{ messages: [{ role: "user", content: [{ type: "image", mediaType: "image/png", data: "iVBORw0KGgo=" }] }] }, "imageInput"],
  ];
  for (const [extra, feature] of refusals) {
    const err = await failure(adapter.generate(req(extra), { signal: live() }));
    assert.equal(err.code, "unsupported_capability");
    assert.equal(err.details.capability, feature);
  }
  assert.equal(posts(fake.calls).length, 0);
});

test("an output cap above the model limit is refused", async () => {
  const { adapter, fake } = make(ok);
  const err = await failure(adapter.generate(req({ maxOutputTokens: 70_000 }), { signal: live() }));
  assert.equal(err.code, "invalid_request");
  assert.equal(posts(fake.calls).length, 0);
});

// -------------------------------------------------------- request mapping

test("a full request maps field by field to the Messages API shape", async () => {
  const info = modelInfo(MODEL, { capabilities: { image_input: { supported: true } } });
  const f = fakeFetch((call, counter) => (call.init.method === "GET" ? jsonResponse(counter, 200, info) : sseResponse(counter, textReply("ok"))));
  const a = createAnthropicAdapter({ connectionId: "c", apiKey: () => CREDENTIAL, fetch: f.fetch });
  await a.generate(
    {
      model: MODEL,
      system: "be brief",
      maxOutputTokens: 100,
      stopSequences: ["END"],
      toolChoice: "auto",
      tools: [{ name: "read_file", description: "Read.", inputSchema: { type: "object", properties: { path: { type: "string" } } } }],
      providerOptions: { "other-provider": { anything: true } },
      messages: [
        { role: "user", content: [{ type: "text", text: "look" }, { type: "image", mediaType: "image/png", data: "iVBORw0KGgo=" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "a" } }] },
        { role: "user", content: [{ type: "tool_result", toolUseId: "toolu_1", content: "file text", isError: true }, { type: "tool_result", toolUseId: "toolu_1", content: [{ type: "text", text: "more" }] }] },
      ],
    },
    { signal: live() },
  );
  const post = f.calls.find((c) => c.init.method === "POST");
  assert.equal(post?.url, "https://api.anthropic.com/v1/messages");
  assert.deepEqual(JSON.parse(post?.init.body ?? "null"), {
    model: MODEL,
    messages: [
      { role: "user", content: [{ type: "text", text: "look" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } }] },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "a" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "file text", is_error: true }, { type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "more" }] }] },
    ],
    system: "be brief",
    tools: [{ name: "read_file", description: "Read.", input_schema: { type: "object", properties: { path: { type: "string" } } } }],
    tool_choice: { type: "auto" },
    max_tokens: 100,
    stop_sequences: ["END"],
    stream: true,
  });
});

test("a request over the size cap is refused before it is sent", async () => {
  const { adapter, fake } = make(ok, { limits: { maxRequestBytes: 200 } });
  const err = await failure(adapter.generate(req({ system: "x".repeat(500) }), { signal: live() }));
  assert.equal(err.code, "invalid_request");
  assert.equal(err.details.reason, "request_too_large");
  assert.equal(posts(fake.calls).length, 0);
});

test("limit options are validated", () => {
  assert.throws(() => make(ok, { limits: { maxLineBytes: 0 } }), RangeError);
  assert.throws(() => make(ok, { limits: { maxRawEvents: Number.NaN } }), RangeError);
  assert.throws(() => make(ok, { limits: { maxStreamBytes: 1.5 } }), RangeError);
});

// ------------------------------------------------------------- countTokens

test("countTokens sends only the fields the endpoint takes", async () => {
  const { adapter, fake } = make((_c, counter) => jsonResponse(counter, 200, { input_tokens: 77 }));
  const n = await adapter.countTokens?.(
    req({ system: "s", toolChoice: "auto", tools: [{ name: "t", description: "d", inputSchema: { type: "object" } }], stopSequences: ["E"], maxOutputTokens: 9 }),
    { signal: live() },
  );
  assert.deepEqual(n, { inputTokens: 77 });
  const post = posts(fake.calls)[0];
  assert.equal(post?.url, "https://api.anthropic.com/v1/messages/count_tokens");
  assert.deepEqual(Object.keys(JSON.parse(post?.init.body ?? "{}")).sort(), ["messages", "model", "system", "tool_choice", "tools"]);
  assert.equal(post?.init.headers["accept"], "application/json");
});

test("countTokens refuses a malformed answer", async () => {
  for (const body of [{ input_tokens: -1 }, { input_tokens: 1.5 }, { input_tokens: "7" }, {}, "[]"]) {
    const { adapter } = make((_c, counter) => jsonResponse(counter, 200, body));
    assert.equal((await failure(adapter.countTokens?.(req(), { signal: live() }) as Promise<unknown>)).code, "invalid_response");
  }
});

// -------------------------------------------------------------- listModels

test("listModels follows pages, drops duplicates and invalid ids, and stops at the page cap", async () => {
  let page = 0;
  const { adapter, fake } = make((call, counter) => {
    page += 1;
    return jsonResponse(counter, 200, {
      data: [{ id: `m${page}`, display_name: `Model ${page}` }, { id: `m${page}` }, { id: "bad id" }, { id: 5 }, "junk"],
      has_more: true,
      last_id: `m${page}`,
    });
    void call;
  });
  const models = await adapter.listModels({ signal: live() });
  assert.deepEqual(models.map((m) => m.id), ["m1", "m2", "m3", "m4", "m5"]);
  assert.equal(models[0]?.displayName, "Model 1");
  assert.equal(fake.calls.length, 5);
  assert.ok(fake.calls[1]?.url.includes("after_id=m1"));
});

test("listModels with a repeated cursor stops, and validateConnection reports instead of throwing", async () => {
  const { adapter, fake } = make((_c, counter) => jsonResponse(counter, 200, { data: [{ id: "a" }], has_more: true, last_id: "a" }));
  assert.equal((await adapter.listModels({ signal: live() })).length, 1);
  assert.equal(fake.calls.length, 2);
  const bad = make((_c, counter) => jsonResponse(counter, 401, {}));
  const r = await bad.adapter.validateConnection({ signal: live() });
  assert.ok(!r.ok && r.error.code === "authentication");
  const c = new AbortController();
  c.abort();
  await failure(bad.adapter.validateConnection({ signal: c.signal }) as Promise<unknown>);
});

// -------------------------------------------------------------- HTTP errors

test("the status table", () => {
  const table: Array<[number, string]> = [
    [400, "invalid_request"], [401, "authentication"], [402, "permission_denied"], [403, "permission_denied"], [404, "not_found"],
    [408, "timeout"], [409, "invalid_request"], [413, "invalid_request"], [418, "invalid_request"], [422, "invalid_request"], [429, "rate_limited"],
    [500, "server_error"], [502, "server_error"], [503, "overloaded"], [504, "timeout"], [529, "overloaded"], [201, "invalid_response"], [204, "invalid_response"],
  ];
  for (const [status, code] of table) assert.equal(codeForStatus(status), code, String(status));
});

test("Retry-After honours whole seconds only, and only for statuses that carry it", async () => {
  assert.equal(parseRetryAfter("3"), 3_000);
  assert.equal(parseRetryAfter(" 12 "), 12_000);
  for (const bad of [null, "", "-5", "1e9", "Wed, 21 Oct 2026 07:28:00 GMT", "1.5", "99999999", "3 seconds"]) assert.equal(parseRetryAfter(bad), undefined, String(bad));
  const { adapter } = make((_c, counter) => response(counter, 500, [], { "retry-after": "9" }));
  assert.equal((await failure(adapter.generate(req(), { signal: live() }))).details.retryAfterMs, undefined);
  const limited = make((_c, counter) => response(counter, 429, [], { "retry-after": "9" }));
  assert.equal((await failure(limited.adapter.generate(req(), { signal: live() }))).details.retryAfterMs, 9_000);
});

test("a 200 that is not a body, and other 2xx statuses, are invalid responses", async () => {
  const none = make((_c, _counter) => ({ status: 200, headers: { get: () => null }, body: null }));
  assert.equal((await failure(none.adapter.generate(req(), { signal: live() }))).details.reason, "no_body");
  const odd = make((_c, counter) => response(counter, 204, []));
  assert.equal((await failure(odd.adapter.generate(req(), { signal: live() }))).code, "invalid_response");
});

// --------------------------------------------------------------------- cost

test("estimateCost: exact, rounded up, and unpriced whenever it cannot be trusted", () => {
  const p = { inputMicroUsdPerMTok: 3_000_000, outputMicroUsdPerMTok: 15_000_000 };
  assert.deepEqual(priceUsage(p, { inputTokens: 1_000, outputTokens: 500 }), { microUsd: 10_500 });
  assert.deepEqual(priceUsage({ inputMicroUsdPerMTok: 1, outputMicroUsdPerMTok: 1 }, { inputTokens: 1, outputTokens: 0 }), { microUsd: 1 }, "rounds up");
  assert.deepEqual(priceUsage(p, { inputTokens: 0, outputTokens: 0 }), { microUsd: 0 });
  assert.equal(priceUsage(p, { inputTokens: 1, outputTokens: 1, cacheReadTokens: 10 }), undefined, "cache tokens without a cache price");
  assert.deepEqual(priceUsage({ ...p, cacheReadMicroUsdPerMTok: 300_000 }, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 }), { microUsd: 300_000 });
  assert.equal(priceUsage(p, { inputTokens: 2 ** 52, outputTokens: 0 }), undefined, "beyond a safe integer");
  assert.equal(priceUsage({ inputMicroUsdPerMTok: Number.NaN, outputMicroUsdPerMTok: 1 }, { inputTokens: 5, outputTokens: 0 }), undefined);
  assert.equal(priceUsage({ inputMicroUsdPerMTok: -1, outputMicroUsdPerMTok: 1 }, { inputTokens: 5, outputTokens: 0 }), undefined);
  assert.equal(priceUsage({ inputMicroUsdPerMTok: 1.5, outputMicroUsdPerMTok: 1 }, { inputTokens: 5, outputTokens: 0 }), undefined);
  assert.equal(priceUsage(undefined, { inputTokens: 1, outputTokens: 1 }), undefined);
});

test("the adapter prices only models its pricing function knows, and a throwing function means unpriced", async () => {
  const priced = make(ok, { pricing: (m) => (m === MODEL ? { inputMicroUsdPerMTok: 1_000_000, outputMicroUsdPerMTok: 1_000_000 } : undefined) });
  assert.deepEqual(priced.adapter.estimateCost?.(MODEL, { inputTokens: 5, outputTokens: 5 }), { microUsd: 10 });
  assert.equal(priced.adapter.estimateCost?.("other", { inputTokens: 5, outputTokens: 5 }), undefined);
  assert.equal((await priced.adapter.getCapabilities(MODEL, { signal: live() })).features.costEstimation, "supported");
  const throwing = make(ok, { pricing: () => { throw new Error("config gone"); } });
  assert.equal(throwing.adapter.estimateCost?.(MODEL, { inputTokens: 5, outputTokens: 5 }), undefined);
  const none = make(ok);
  assert.equal(none.adapter.estimateCost?.(MODEL, { inputTokens: 5, outputTokens: 5 }), undefined);
  assert.equal((await none.adapter.getCapabilities(MODEL, { signal: live() })).features.costEstimation, "unsupported");
});
