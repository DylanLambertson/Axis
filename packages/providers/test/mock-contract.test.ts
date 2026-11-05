// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Runs the shared adapter contract suite against the mock provider. Ticket 9
// runs the same suite against the Anthropic adapter with a fake transport.
import { runProviderContractSuite, type ContractScenario } from "../contract/index.js";
import { MOCK_DEFAULT_MODEL, createMockProvider, type MockReply } from "../src/index.js";

const CANARY = "contract-canary-body-text";
// Low-entropy stand-in for an API key.
const CREDENTIAL = "contract-credential-stand-in";

function replyFor(s: ContractScenario): MockReply {
  switch (s.kind) {
    case "text":
      return { kind: "text", text: s.text };
    case "max_tokens":
      return { kind: "text", text: s.text, stopReason: "max_tokens" };
    case "tool_use":
      return { kind: "tool_use", name: s.name, input: s.input };
    case "error":
      return {
        kind: "error",
        code: s.code,
        body: `{"error":"${CANARY}","key":"${CREDENTIAL}"}`,
        ...(s.retryAfterMs === undefined ? {} : { retryAfterMs: s.retryAfterMs }),
      };
    case "mid_stream_error":
      return { kind: "error", code: "overloaded", afterText: s.text, body: `${CANARY} ${CREDENTIAL}` };
    case "hang":
      return { kind: "hang" };
    case "malformed":
      return { kind: "malformed" };
    case "redirect":
      // The mock has no wire; a redirect is the invalid response a
      // non-following adapter reports.
      return { kind: "error", code: "invalid_response" };
  }
}

runProviderContractSuite({
  name: "mock",
  canary: CANARY,
  credential: CREDENTIAL,
  noNetwork: "the mock provider runs in process and makes no network request",
  setup(scenario) {
    const mock = createMockProvider({
      replies: [replyFor(scenario)],
      chunkChars: 4,
      credential: CREDENTIAL,
      ...(scenario.kind === "error" && scenario.code === "authentication" ? { connectionError: "authentication" as const } : {}),
      ...(scenario.kind === "redirect" ? { connectionError: "invalid_response" as const } : {}),
    });
    return {
      adapter: mock,
      model: MOCK_DEFAULT_MODEL,
      requestCount: () => mock.requests.length,
      openStreams: () => mock.openStreams,
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
