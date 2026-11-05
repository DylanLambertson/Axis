// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { z } from "zod";
import { ProviderError, type ValidRequest } from "@axis/providers";
import type { JsonValue } from "@axis/protocol";

export const PROVIDER_OPTIONS_KEY = "anthropic";

/**
 * Options for this provider in `providerOptions.anthropic`. None exist in v1:
 * any key is refused. A future option needs a review that it cannot change the
 * origin, headers, auth or redirect handling (the contract suite checks that).
 */
const ownOptionsSchema = z.strictObject({});

/** Refuse any entry of our own in `providerOptions`; other providers' entries are ignored. */
export function checkOwnOptions(request: ValidRequest): void {
  const own = request.providerOptions?.[PROVIDER_OPTIONS_KEY];
  if (own === undefined) return;
  if (!ownOptionsSchema.safeParse(own).success) {
    throw new ProviderError("invalid_request", { message: "The Anthropic adapter accepts no provider options.", reason: "provider_options" });
  }
}

type Obj = { [key: string]: JsonValue };

function blockToWire(b: ValidRequest["messages"][number]["content"][number]): Obj {
  switch (b.type) {
    case "text":
      return { type: "text", text: b.text };
    case "image":
      return { type: "image", source: { type: "base64", media_type: b.mediaType, data: b.data } };
    case "tool_use":
      return { type: "tool_use", id: b.id, name: b.name, input: b.input };
    case "tool_result": {
      const out: Obj = {
        type: "tool_result",
        tool_use_id: b.toolUseId,
        content: typeof b.content === "string" ? b.content : b.content.map((t) => ({ type: "text", text: t.text })),
      };
      if (b.isError !== undefined) out["is_error"] = b.isError;
      return out;
    }
  }
}

function toolChoiceToWire(tc: NonNullable<ValidRequest["toolChoice"]>): Obj {
  return typeof tc === "string" ? { type: tc } : { type: "tool", name: tc.name };
}

/** Fields shared by the message and token-count bodies. Built field by field: nothing unknown is copied. */
function common(r: ValidRequest): Obj {
  const out: Obj = {
    model: r.model,
    messages: r.messages.map((m) => ({ role: m.role, content: m.content.map(blockToWire) })),
  };
  if (r.system !== undefined) out["system"] = r.system;
  if (r.tools !== undefined && r.tools.length > 0) {
    out["tools"] = r.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
  }
  if (r.toolChoice !== undefined) out["tool_choice"] = toolChoiceToWire(r.toolChoice);
  return out;
}

export function messagesBody(r: ValidRequest): Obj {
  const out = common(r);
  out["max_tokens"] = r.maxOutputTokens;
  if (r.temperature !== undefined) out["temperature"] = r.temperature;
  if (r.stopSequences !== undefined && r.stopSequences.length > 0) out["stop_sequences"] = [...r.stopSequences];
  out["stream"] = true;
  return out;
}

export function countTokensBody(r: ValidRequest): Obj {
  return common(r);
}

/** Serialize and enforce the size cap before anything is sent. */
export function serialize(body: Obj, maxBytes: number): string {
  let json: string;
  try {
    json = JSON.stringify(body);
  } catch {
    throw new ProviderError("invalid_request", { reason: "schema" });
  }
  if (Buffer.byteLength(json, "utf8") > maxBytes) throw new ProviderError("invalid_request", { reason: "request_too_large" });
  return json;
}
