// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { ProviderError } from "@axis/providers";
import type { BodyStream } from "./transport.js";

/**
 * True when `text` nests objects or arrays deeper than `max`. A linear scan
 * that tracks strings and escapes, so a deeply nested document is refused
 * before `JSON.parse` sees it.
 */
export function jsonDepthExceeds(text: string, max: number): boolean {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (escaped) escaped = false;
      else if (c === 0x5c) escaped = true;
      else if (c === 0x22) inString = false;
      continue;
    }
    if (c === 0x22) inString = true;
    else if (c === 0x7b || c === 0x5b) {
      depth += 1;
      if (depth > max) return true;
    } else if ((c === 0x7d || c === 0x5d) && depth > 0) depth -= 1;
  }
  return false;
}

/** Parse bounded JSON; the error carries a fixed reason and never the text. */
export function parseJson(text: string, maxDepth: number, reason = "malformed_event"): unknown {
  if (jsonDepthExceeds(text, maxDepth)) throw new ProviderError("invalid_response", { reason: "event_too_deep" });
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderError("invalid_response", { reason });
  }
}

/**
 * Read a whole body of at most `maxBytes` and decode it as UTF-8. With
 * `truncate` a longer body is cut at the cap instead of refused (error bodies:
 * only a prefix is ever looked at).
 */
export async function readText(body: BodyStream, maxBytes: number, truncate = false): Promise<string> {
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const chunk = await body.next();
    if (chunk === undefined) break;
    if (total + chunk.length > maxBytes) {
      if (!truncate) throw new ProviderError("invalid_response", { reason: "response_too_large" });
      parts.push(chunk.subarray(0, maxBytes - total));
      total = maxBytes;
      break;
    }
    parts.push(chunk.slice());
    total += chunk.length;
  }
  const all = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    all.set(p, off);
    off += p.length;
  }
  try {
    return new TextDecoder("utf-8", { fatal: !truncate }).decode(all);
  } catch {
    throw new ProviderError("invalid_response", { reason: "bad_encoding" });
  }
}
