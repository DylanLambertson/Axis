// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Findings of the fourth review: a window too small to hold a match twice over is refused, never scanned as if complete.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_LIMITS, MIN_LINE_LENGTH, WINDOW_OVERLAP, createSecretScanner, scanText } from "../src/index.js";
import { canary, patch, rules } from "./helpers.js";

const FILLER = "x ";

test("S-1: a window below the minimum is refused by the scanner and by scanText", () => {
  for (const maxLineLength of [64, 128, 4096, MIN_LINE_LENGTH - 1]) {
    assert.throws(() => createSecretScanner({ mode: "refuse", maxLineLength }), (e: unknown) => e instanceof RangeError && /maxLineLength/.test(e.message));
    assert.throws(() => scanText(patch("a.txt", ["hello world"]), {}, { ...DEFAULT_LIMITS, maxLineLength }, () => 0), RangeError);
  }
  assert.throws(() => scanText("x", {}, { ...DEFAULT_LIMITS, maxLineLength: Number.NaN }, () => 0), RangeError);
});

test("S-1: with the smallest accepted window, a token is found at every offset across the window edges", async () => {
  const w = MIN_LINE_LENGTH;
  const scanner = createSecretScanner({ mode: "refuse", maxLineLength: w, now: () => 0 });
  const token = canary.github(28);
  // Offsets chosen around the first and second window edges and the overlap start, so a token straddles each.
  const starts = new Set<number>();
  for (const edge of [w, w + (w - WINDOW_OVERLAP), w + 2 * (w - WINDOW_OVERLAP)]) for (let d = -token.length - 2; d <= 2; d += 1) starts.add(edge + d);
  for (const at of starts) {
    const line = FILLER.repeat(Math.floor(at / 2)) + (at % 2 ? " " : "") + token + " end";
    assert.deepEqual(rules(await scanner.scan(patch("a.txt", [line]), {})), ["github-token"], `at ${at}`);
  }
});

test("S-1: the minimum and the default are both safe for a token placed across a window edge", async () => {
  const token = canary.github(29);
  for (const maxLineLength of [MIN_LINE_LENGTH, DEFAULT_LIMITS.maxLineLength]) {
    const line = FILLER.repeat((maxLineLength - 20) / 2) + token + " end";
    const found = await createSecretScanner({ mode: "refuse", maxLineLength, now: () => 0 }).scan(patch("a.txt", [line]), {});
    assert.deepEqual(rules(found), ["github-token"], `window ${maxLineLength}`);
  }
});
