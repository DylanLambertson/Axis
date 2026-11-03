// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Deliberately leaky adapters, run through the contract suite in a child
// process by contract-suite.test.ts. The suite must fail every variant
// (review S9, re-review NS1 and NS5). `LEAK` selects the variant. Not named
// *.test.ts, so `npm test` does not run it directly.
import { runProviderContractSuite, type ContractScenario } from "../../contract/index.js";
import { MOCK_DEFAULT_MODEL, ProviderError, createMockProvider, type MockReply, type ProviderAdapter, type StreamEvent } from "../../src/index.js";

const CANARY = "leaky-canary-body";
const CREDENTIAL = "leaky-credential-stand-in";
const LEAK = process.env["LEAK"] ?? "error-props";

function reply(s: ContractScenario): MockReply {
  switch (s.kind) {
    case "text":
      return { kind: "text", text: s.text };
    case "max_tokens":
      // maxtok: the credential appears in a max_tokens reply.
      return { kind: "text", text: LEAK === "maxtok" ? `${s.text} ${CREDENTIAL}` : s.text, stopReason: "max_tokens" };
    case "tool_use":
      return { kind: "tool_use", name: s.name, input: s.input };
    case "error":
      return { kind: "error", code: s.code, ...(s.retryAfterMs === undefined ? {} : { retryAfterMs: s.retryAfterMs }) };
    case "mid_stream_error":
      // midstream-delta: the provider error body is echoed into a text delta first.
      return { kind: "error", code: "overloaded", afterText: LEAK === "midstream-delta" ? `${s.text} ${CANARY} ${CREDENTIAL}` : s.text };
    case "hang":
      return { kind: "hang" };
    case "malformed":
      return { kind: "malformed" };
    case "redirect":
      return { kind: "error", code: "invalid_response" };
  }
}

/** error-props: re-throw as a ProviderError-looking object carrying the body, which JSON.stringify hides. */
function leakProps(e: unknown): never {
  if (!(e instanceof ProviderError)) throw e;
  const o = Object.create(ProviderError.prototype) as Record<string, unknown>;
  Object.assign(o, { name: "ProviderError", code: e.code, message: e.message, retryable: e.retryable, details: { ...e.details }, body: `${CANARY} ${CREDENTIAL}` });
  throw o;
}

/** masked: the error message echoes part of the key, as provider error bodies often do. */
function leakMasked(e: unknown): never {
  if (!(e instanceof ProviderError)) throw e;
  throw new ProviderError(e.code, { ...e.details, message: `Incorrect API key provided: ${CREDENTIAL.slice(0, 20)}****` });
}

const onError = LEAK === "error-props" ? leakProps : LEAK === "masked" ? leakMasked : (e: unknown): never => { throw e; };

function mapEvent(ev: StreamEvent): StreamEvent {
  if (LEAK === "error-props" && ev.type === "message_start") return { ...ev, id: CREDENTIAL };
  // tool-id: the credential is the tool-use id on the stream path.
  if (LEAK === "tool-id" && ev.type === "content_block_start" && ev.block.type === "tool_use") return { ...ev, block: { ...ev.block, id: CREDENTIAL } };
  return ev;
}

runProviderContractSuite({
  name: `leaky (${LEAK})`,
  canary: CANARY,
  credential: CREDENTIAL,
  setup(scenario) {
    const mock = createMockProvider({
      replies: [reply(scenario)],
      ...(scenario.kind === "error" && scenario.code === "authentication" ? { connectionError: "authentication" as const } : {}),
      ...(scenario.kind === "redirect" ? { connectionError: "invalid_response" as const } : {}),
    });
    let last: { model: string; maxOutputTokens: number; system?: string; stopSequences?: readonly string[] } | undefined;
    // error-props also "accepts" any providerOptions by stripping them.
    // drop-cap: the adapter ignores the caller's output cap and sends its own.
    const send = (r: Parameters<ProviderAdapter["generate"]>[0]) => {
      const out = {
        ...r,
        ...(LEAK === "error-props" ? { providerOptions: {} } : {}),
        ...(LEAK === "drop-cap" ? { maxOutputTokens: 32_000 } : {}),
      };
      last = {
        model: String(out.model),
        maxOutputTokens: out.maxOutputTokens,
        ...(out.system === undefined ? {} : { system: out.system }),
        ...(out.stopSequences === undefined ? {} : { stopSequences: out.stopSequences }),
      };
      return out;
    };
    const adapter: ProviderAdapter = {
      descriptor: mock.descriptor,
      listModels: (o) => mock.listModels(o),
      getCapabilities: (m, o) => mock.getCapabilities(m, o),
      validateConnection: (o) => mock.validateConnection(o),
      countTokens: (r, o) => (mock.countTokens as NonNullable<ProviderAdapter["countTokens"]>)(r, o),
      estimateCost: (m, u) => mock.estimateCost?.(m, u),
      generate: (r, o) => mock.generate(send(r), o).catch(onError),
      stream: (r, o) => ({
        async *[Symbol.asyncIterator]() {
          try {
            for await (const ev of mock.stream(send(r), o)) yield mapEvent(ev);
          } catch (e) {
            onError(e);
          }
        },
      }),
    };
    return {
      adapter,
      model: MOCK_DEFAULT_MODEL,
      requestCount: () => mock.requests.length,
      openStreams: () => mock.openStreams,
      lastRequest: () => last,
      forwardedRequests: () => [],
    };
  },
});
