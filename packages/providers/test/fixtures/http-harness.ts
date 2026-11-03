// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// A fake HTTP adapter: the mock behind a recording transport with a real
// https origin. contract-suite.test.ts runs it in a child process.
// FOLLOW=0: a well-behaved adapter that refuses redirects; it must pass the
//           whole suite, which shows the redirect checks are not vacuous.
// FOLLOW=1: an adapter that follows redirects and re-sends its key to the
//           Location host; the suite must fail it (ANT-1).
// FOLLOW=fail: follows, then reports invalid_response anyway; the off-origin
//           check alone must fail it.
// Not named *.test.ts, so `npm test` does not run it directly.
import { runProviderContractSuite, type ContractScenario, type WireRequest } from "../../contract/index.js";
import {
  MOCK_DEFAULT_MODEL,
  ProviderError,
  createMockProvider,
  validateRequest,
  type GenerateRequest,
  type MockReply,
  type ProviderAdapter,
} from "../../src/index.js";

const ORIGIN = "https://api.provider.test";
const ELSEWHERE = "https://elsewhere.example.test";
const CANARY = "http-canary-body-text";
// Low-entropy stand-in for an API key.
const CREDENTIAL = "http-credential-stand-in";
const MODE = process.env["FOLLOW"] ?? "0";
const FOLLOW = MODE !== "0";

function reply(s: ContractScenario): MockReply {
  switch (s.kind) {
    case "text":
      return { kind: "text", text: s.text };
    case "max_tokens":
      return { kind: "text", text: s.text, stopReason: "max_tokens" };
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
    case "redirect":
      // Only reached by the following adapter: the Location host answers.
      return { kind: "text", text: "answered by the redirect target" };
  }
}

runProviderContractSuite({
  name: FOLLOW ? `http (follows redirects: ${MODE})` : "http",
  canary: CANARY,
  credential: CREDENTIAL,
  setup(scenario) {
    const mock = createMockProvider({
      replies: [reply(scenario)],
      ...(scenario.kind === "error" && scenario.code === "authentication" ? { connectionError: "authentication" as const } : {}),
    });
    const wire: WireRequest[] = [];

    /** The transport: records the request, then answers a redirect scenario with its status. */
    const send = (path: string, body?: unknown): void => {
      const headers = { "x-api-key": CREDENTIAL, "content-type": "application/json" };
      const text = body === undefined ? undefined : JSON.stringify(body);
      wire.push({ url: `${ORIGIN}${path}`, headers, ...(text === undefined ? {} : { body: text }) });
      if (scenario.kind !== "redirect") return;
      if (!FOLLOW) throw new ProviderError("invalid_response", { status: scenario.status, reason: "redirect" });
      // The defect under test: the request, key included, goes to the Location host.
      wire.push({ url: `${ELSEWHERE}${path}`, headers, ...(text === undefined ? {} : { body: text }) });
      if (MODE === "fail") throw new ProviderError("invalid_response", { status: scenario.status, reason: "redirect" });
    };
    /** Validate and honour the signal before anything reaches the transport. */
    const before = (r: GenerateRequest, signal: AbortSignal) => {
      if (signal.aborted) throw new ProviderError("cancelled");
      return validateRequest(r);
    };

    const adapter: ProviderAdapter = {
      descriptor: Object.freeze({ ...mock.descriptor, destination: Object.freeze({ origin: ORIGIN, description: "Fake HTTP provider" }) }),
      listModels: async (o) => {
        send("/v1/models");
        return mock.listModels(o);
      },
      getCapabilities: (m, o) => mock.getCapabilities(m, o),
      validateConnection: async (o) => {
        try {
          send("/v1/models");
        } catch (e) {
          if (e instanceof ProviderError) return { ok: false, error: e };
          throw e;
        }
        return mock.validateConnection(o);
      },
      generate: async (r, o) => {
        send("/v1/messages", before(r, o.signal));
        return mock.generate(r, o);
      },
      stream: (r, o) => ({
        async *[Symbol.asyncIterator]() {
          send("/v1/messages", before(r, o.signal));
          yield* mock.stream(r, o);
        },
      }),
      countTokens: async (r, o) => {
        send("/v1/messages/count_tokens", before(r, o.signal));
        return (mock.countTokens as NonNullable<ProviderAdapter["countTokens"]>)(r, o);
      },
      estimateCost: (m, u) => mock.estimateCost?.(m, u),
    };
    return {
      adapter,
      model: MOCK_DEFAULT_MODEL,
      requestCount: () => mock.requests.length,
      openStreams: () => mock.openStreams,
      forwardedRequests: () => wire,
      lastRequest: () => {
        const r = mock.requests.at(-1);
        if (r === undefined) return undefined;
        return {
          model: r.model,
          maxOutputTokens: r.maxOutputTokens,
          ...(r.system === undefined ? {} : { system: r.system }),
          ...(r.stopSequences === undefined ? {} : { stopSequences: r.stopSequences }),
        };
      },
    };
  },
});
