// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { ProviderError } from "./errors.js";
import { read } from "./guard-util.js";
import { StreamValidator, type StreamLimits } from "./stream.js";
import type { GenerateResult } from "./types.js";

/** Run a `generate` result through the stream grammar, so both paths are held to the same rules. */
export function checkResult(raw: unknown, limits: StreamLimits): GenerateResult {
  const bad = (): ProviderError => new ProviderError("invalid_response", { reason: "malformed_result" });
  if (typeof raw !== "object" || raw === null) throw bad();
  const content = read(raw, "content");
  if (!Array.isArray(content)) throw bad();
  const id = read(raw, "id");
  const v = new StreamValidator(limits);
  v.accept(id === undefined ? { type: "message_start", model: read(raw, "model") } : { type: "message_start", id, model: read(raw, "model") });
  content.forEach((b: unknown, index: number) => {
    if (typeof b !== "object" || b === null) throw bad();
    const type = read(b, "type");
    if (type === "text") {
      v.accept({ type: "content_block_start", index, block: { type: "text" } });
      v.accept({ type: "content_block_delta", index, delta: { type: "text", text: read(b, "text") } });
    } else if (type === "tool_use") {
      v.accept({ type: "content_block_start", index, block: { type: "tool_use", id: read(b, "id"), name: read(b, "name") } });
      const input = read(b, "input");
      // A tool call without input is malformed, not `{}` (N6).
      if (input === undefined) throw new ProviderError("invalid_response", { reason: "tool_input_missing" });
      let json: string | undefined;
      try {
        json = JSON.stringify(input);
      } catch {
        json = undefined;
      }
      if (json === undefined) throw new ProviderError("invalid_response", { reason: "tool_input_not_json" });
      v.accept({ type: "content_block_delta", index, delta: { type: "tool_input", partialJson: json } });
    } else {
      throw bad();
    }
    v.accept({ type: "content_block_stop", index });
  });
  v.accept({ type: "message_stop", stopReason: read(raw, "stopReason"), usage: read(raw, "usage") });
  return v.result();
}
