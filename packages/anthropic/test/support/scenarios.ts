// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// A scripted "Anthropic" for the shared contract suite: models endpoints that
// always work, and a messages endpoint that follows the scenario. Error
// responses echo the canary and the credential into the body and a header.
import type { ContractScenario, ForwardedRequest } from "@axis/providers/contract";
import {
  OpenCounter,
  chunkBytes,
  fakeFetch,
  jsonResponse,
  modelInfo,
  response,
  sseEvent,
  sseResponse,
  textReply,
  type FakeFetch,
  type RecordedCall,
} from "./transport.js";

export const MODEL = "test-model";

const STATUS: Record<string, { status: number; type: string }> = {
  invalid_request: { status: 400, type: "invalid_request_error" },
  authentication: { status: 401, type: "authentication_error" },
  permission_denied: { status: 403, type: "permission_error" },
  not_found: { status: 404, type: "not_found_error" },
  rate_limited: { status: 429, type: "rate_limit_error" },
  overloaded: { status: 529, type: "overloaded_error" },
  server_error: { status: 500, type: "api_error" },
  // Anthropic reports a too-long prompt as a 400; a 413 is a byte-size problem (N4).
  context_length_exceeded: { status: 400, type: "invalid_request_error" },
};

export function scenarioFetch(scenario: ContractScenario, canary: string, credential: string): FakeFetch & { messageRequests(): number; lastRequest(): ForwardedRequest | undefined } {
  const echo = `${canary} ${credential} sk-ant-${credential}`;
  const errorBody = (type: string): unknown => ({ type: "error", error: { type, message: `bad request: ${echo}` }, request_id: `req_${canary}` });
  const f = fakeFetch((call: RecordedCall, counter: OpenCounter) => {
    const url = new URL(call.url);
    if (call.init.method === "GET" && url.pathname.startsWith("/v1/models/")) {
      const id = decodeURIComponent(url.pathname.slice("/v1/models/".length));
      return id === MODEL ? jsonResponse(counter, 200, modelInfo(MODEL)) : jsonResponse(counter, 404, errorBody("not_found_error"), { "x-echo": credential });
    }
    if (call.init.method === "GET" && url.pathname === "/v1/models") {
      if (scenario.kind === "error" && scenario.code === "authentication") {
        return jsonResponse(counter, 401, errorBody("authentication_error"), { "x-echo": credential });
      }
      return jsonResponse(counter, 200, { data: [{ type: "model", id: MODEL, display_name: "Test model" }], has_more: false, first_id: MODEL, last_id: MODEL });
    }
    if (call.init.method === "POST" && url.pathname === "/v1/messages/count_tokens") return jsonResponse(counter, 200, { input_tokens: 42 });
    if (call.init.method === "POST" && url.pathname === "/v1/messages") return messages(scenario, counter, errorBody, credential, echo);
    return jsonResponse(counter, 404, errorBody("not_found_error"));
  });
  const sent = (): RecordedCall[] => f.calls.filter((c) => c.init.method === "POST" && c.url.endsWith("/v1/messages"));
  return Object.assign(f, {
    messageRequests: () => sent().length,
    /** The last message request as it went on the wire, with the HTTP field names mapped back. */
    lastRequest: (): ForwardedRequest | undefined => {
      const last = sent().at(-1);
      if (last === undefined) return undefined;
      const b = JSON.parse(last.init.body ?? "{}") as { model: string; max_tokens: number; system?: string; stop_sequences?: string[] };
      return { model: b.model, maxOutputTokens: b.max_tokens, ...(b.system === undefined ? {} : { system: b.system }), ...(b.stop_sequences === undefined ? {} : { stopSequences: b.stop_sequences }) };
    },
  });
}

function messages(s: ContractScenario, counter: OpenCounter, errorBody: (t: string) => unknown, credential: string, errorMessageEcho: string) {
  switch (s.kind) {
    case "text":
      return sseResponse(counter, textReply(s.text));
    case "max_tokens":
      return sseResponse(counter, textReply(s.text, { stopReason: "max_tokens" }));
    case "tool_use": {
      const json = JSON.stringify(s.input);
      let out = sseEvent("message_start", { type: "message_start", message: { id: "msg_t", model: MODEL, usage: { input_tokens: 20, output_tokens: 1 } } });
      out += sseEvent("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_test_1", name: s.name, input: {} } });
      for (let i = 0; i < json.length; i += 5) {
        out += sseEvent("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: json.slice(i, i + 5) } });
      }
      out += sseEvent("content_block_stop", { type: "content_block_stop", index: 0 });
      out += sseEvent("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 15 } });
      out += sseEvent("message_stop", { type: "message_stop" });
      return sseResponse(counter, out, 9);
    }
    case "error": {
      const e = STATUS[s.code] as { status: number; type: string };
      const headers: Record<string, string> = { "x-echo": credential };
      if (s.retryAfterMs !== undefined) headers["retry-after"] = String(Math.round(s.retryAfterMs / 1000));
      if (s.code === "context_length_exceeded") {
        return jsonResponse(counter, 400, { type: "error", error: { type: "invalid_request_error", message: `prompt is too long: 250000 tokens > 200000 maximum ${errorMessageEcho}` } }, headers);
      }
      return jsonResponse(counter, e.status, errorBody(e.type), headers);
    }
    case "mid_stream_error": {
      let out = sseEvent("message_start", { type: "message_start", message: { id: "msg_m", model: MODEL, usage: { input_tokens: 9, output_tokens: 1 } } });
      out += sseEvent("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      out += sseEvent("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: s.text } });
      out += sseEvent("error", errorBody("overloaded_error"));
      return sseResponse(counter, out);
    }
    case "hang":
      return response(counter, 200, [...chunkBytes(sseEvent("message_start", { type: "message_start", message: { id: "msg_h", model: MODEL, usage: { input_tokens: 5, output_tokens: 1 } } }), 64), "hang"], { "content-type": "text/event-stream" });
    case "malformed":
      return sseResponse(counter, "event: message_start\ndata: {not json at all\n\n");
  }
}
