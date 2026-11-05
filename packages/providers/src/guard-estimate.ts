// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { ValidRequest } from "./validate.js";

/** Tokens charged for an inline image when estimating input (base64 length says little about tokens). */
const IMAGE_TOKEN_ESTIMATE = 2_000;

/** Fixed overheads, in tokens, for the request envelope, each message, and tool use (the provider's tool prompt). */
const REQUEST_OVERHEAD_TOKENS = 64;
const MESSAGE_OVERHEAD_TOKENS = 8;
const TOOL_USE_OVERHEAD_TOKENS = 512;
const PER_TOOL_OVERHEAD_TOKENS = 64;

/** ASCII characters and other code points in a string. */
function charClasses(s: string, acc: { ascii: number; other: number }): void {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) acc.ascii += 1;
    else {
      acc.other += 1;
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) i += 1; // one code point for a surrogate pair
    }
  }
}

/**
 * A high input estimate, used for budget reservations (NN4). It is an
 * estimate, not a bound: ASCII text at two characters per token; every other
 * code point (CJK, emoji, accents) at two tokens; a fixed charge per request,
 * per message and for tool use (the provider's tool prompt) and per tool; and
 * a flat 2,000 per image, above the roughly 1,600 that providers charge for
 * the largest image they accept without resizing. A provider can still
 * report more; the run budget's overshoot is bounded by that difference.
 */
export function estimateInputTokens(r: ValidRequest): number {
  const acc = { ascii: 0, other: 0 };
  let images = 0;
  if (r.system !== undefined) charClasses(r.system, acc);
  for (const m of r.messages) {
    for (const b of m.content) {
      if (b.type === "text") charClasses(b.text, acc);
      else if (b.type === "image") images += 1;
      else if (b.type === "tool_use") {
        charClasses(JSON.stringify(b.input), acc);
        charClasses(b.name, acc);
      } else if (typeof b.content === "string") charClasses(b.content, acc);
      else for (const t of b.content) charClasses(t.text, acc);
    }
  }
  const tools = r.tools ?? [];
  for (const t of tools) {
    charClasses(t.name, acc);
    charClasses(t.description, acc);
    charClasses(JSON.stringify(t.inputSchema), acc);
  }
  const toolOverhead = tools.length > 0 ? TOOL_USE_OVERHEAD_TOKENS + tools.length * PER_TOOL_OVERHEAD_TOKENS : 0;
  return (
    REQUEST_OVERHEAD_TOKENS +
    r.messages.length * MESSAGE_OVERHEAD_TOKENS +
    Math.ceil(acc.ascii / 2) +
    acc.other * 2 +
    images * IMAGE_TOKEN_ESTIMATE +
    toolOverhead
  );
}

export function requestChars(r: ValidRequest): number {
  let n = r.system?.length ?? 0;
  for (const m of r.messages) for (const b of m.content) if (b.type === "text") n += b.text.length;
  return n;
}
