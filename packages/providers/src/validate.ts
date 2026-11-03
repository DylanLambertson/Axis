// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { ProviderError } from "./errors.js";
import {
  generateRequestSchema,
  type Feature,
  type GenerateRequest,
  type ModelCapabilities,
} from "./types.js";

/** A request that passed `validateRequest`: parsed, bounded and cloned. */
export type ValidRequest = ReturnType<typeof generateRequestSchema.parse>;

/** The features a request uses, so a model that lacks one can refuse it. */
export function featuresUsed(request: ValidRequest, mode: "generate" | "stream"): Set<Feature> {
  const used = new Set<Feature>();
  if (mode === "stream") used.add("streaming");
  if (request.system !== undefined) used.add("systemPrompt");
  if (request.tools !== undefined && request.tools.length > 0) used.add("toolUse");
  if (request.toolChoice !== undefined && request.toolChoice !== "auto") used.add("toolChoice");
  if (request.stopSequences !== undefined && request.stopSequences.length > 0) used.add("stopSequences");
  if (request.temperature !== undefined) used.add("temperature");
  for (const m of request.messages) {
    for (const b of m.content) {
      if (b.type === "image") used.add("imageInput");
      else if (b.type === "tool_use" || b.type === "tool_result") used.add("toolUse");
    }
  }
  return used;
}

/**
 * Validate a request before anything is sent. Throws `invalid_request` for a
 * malformed request and `unsupported_capability` when `capabilities` is given
 * and the request uses a feature the model does not report as `supported`
 * (`unknown` is refused too: never silently emulated, PRODUCT scenario 10).
 * Error messages name the failing field path only, never a value.
 */
export function validateRequest(
  request: GenerateRequest,
  capabilities?: ModelCapabilities,
  mode: "generate" | "stream" = "generate",
): ValidRequest {
  const parsed = generateRequestSchema.safeParse(request);
  if (!parsed.success) {
    const path = parsed.error.issues[0]?.path.map(String).join(".") ?? "";
    throw new ProviderError("invalid_request", {
      message: path === "" ? "The request is invalid." : `The request field "${safePath(path)}" is invalid.`,
      reason: "schema",
    });
  }
  const req = parsed.data;
  if (capabilities === undefined) return req;

  if (capabilities.modelId !== req.model) {
    throw new ProviderError("invalid_request", { message: "The capability report is for a different model.", reason: "model_mismatch" });
  }
  for (const feature of featuresUsed(req, mode)) {
    const state = capabilities.features[feature];
    if (state !== "supported") {
      throw new ProviderError("unsupported_capability", {
        message: `The model does not support "${feature}" (${state}).`,
        capability: feature,
      });
    }
  }
  const max = capabilities.limits.maxOutputTokens;
  if (max !== undefined && req.maxOutputTokens > max) {
    throw new ProviderError("invalid_request", {
      message: `maxOutputTokens exceeds the model limit of ${max}.`,
      reason: "max_output_tokens",
    });
  }
  return req;
}

/** Field paths come from our schema, but record keys are caller data: keep them short and plain. */
function safePath(path: string): string {
  const cleaned = path.replace(/[^A-Za-z0-9_.-]/g, "?");
  return cleaned.length > 80 ? `${cleaned.slice(0, 80)}…` : cleaned;
}
