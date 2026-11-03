// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// A deliberately leaky adapter, run through the contract suite in a child
// process by contract-suite.test.ts. The suite must fail on it (review S9).
// Not named *.test.ts, so `npm test` does not run it directly.
import { runProviderContractSuite, type ContractScenario } from "../../contract/index.js";
import { MOCK_DEFAULT_MODEL, ProviderError, createMockProvider, type MockReply, type ProviderAdapter, type StreamEvent } from "../../src/index.js";

const CANARY = "leaky-canary-body";
const CREDENTIAL = "leaky-credential-stand-in";

function reply(s: ContractScenario): MockReply {
  switch (s.kind) {
    case "text":
    case "max_tokens":
      return { kind: "text", text: s.text, ...(s.kind === "max_tokens" ? { stopReason: "max_tokens" as const } : {}) };
    case "tool_use":
      return { kind: "tool_use", name: s.name, input: s.input };
    case "error":
      return { kind: "error", code: s.code, ...(s.retryAfterMs === undefined ? {} : { retryAfterMs: s.retryAfterMs }) };
    case "mid_stream_error":
      return { kind: "error", code: "overloaded", afterText: s.text };
    case "hang":
      return { kind: "hang" };
    case "malformed":
      return { kind: "malformed" };
  }
}

/** Re-throw as a ProviderError-looking object that carries the body: the shape JSON.stringify hides. */
function leak(e: unknown): never {
  if (!(e instanceof ProviderError)) throw e;
  const o = Object.create(ProviderError.prototype) as Record<string, unknown>;
  Object.assign(o, { name: "ProviderError", code: e.code, message: e.message, retryable: e.retryable, details: { ...e.details }, body: `${CANARY} ${CREDENTIAL}` });
  throw o;
}

runProviderContractSuite({
  name: "leaky",
  canary: CANARY,
  credential: CREDENTIAL,
  setup(scenario) {
    // Without a strict options check the mock would still refuse its own
    // entry, so the leaky adapter strips providerOptions: it "accepts" them.
    const mock = createMockProvider({ replies: [reply(scenario)] });
    const adapter: ProviderAdapter = {
      descriptor: mock.descriptor,
      listModels: (o) => mock.listModels(o),
      getCapabilities: (m, o) => mock.getCapabilities(m, o),
      validateConnection: (o) => mock.validateConnection(o),
      generate: (r, o) => mock.generate({ ...r, providerOptions: {} }, o).catch(leak),
      stream: (r, o) => ({
        async *[Symbol.asyncIterator]() {
          try {
            for await (const ev of mock.stream({ ...r, providerOptions: {} }, o)) {
              // Puts the credential into an event field.
              yield (ev.type === "message_start" ? { ...ev, id: CREDENTIAL } : ev) as StreamEvent;
            }
          } catch (e) {
            leak(e);
          }
        },
      }),
    };
    return { adapter, model: MOCK_DEFAULT_MODEL, requestCount: () => mock.requests.length, openStreams: () => mock.openStreams };
  },
});
