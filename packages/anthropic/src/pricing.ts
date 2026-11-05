// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { CostEstimate, Usage } from "@axis/providers";

/**
 * Integer micro-USD per million tokens. Supplied by the daemon from reviewed
 * configuration: the adapter has no price or model name of its own.
 */
export interface Pricing {
  readonly inputMicroUsdPerMTok: number;
  readonly outputMicroUsdPerMTok: number;
  readonly cacheReadMicroUsdPerMTok?: number;
  readonly cacheWriteMicroUsdPerMTok?: number;
}

const isRate = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

/**
 * Round-up cost of `usage`, or undefined when it cannot be priced: a rate is
 * invalid, or cache tokens were used and there is no cache rate. BigInt keeps
 * the product exact.
 */
export function priceUsage(pricing: Pricing | undefined, usage: Usage): CostEstimate | undefined {
  if (pricing === undefined) return undefined;
  const parts: Array<[number, number | undefined]> = [
    [usage.inputTokens, pricing.inputMicroUsdPerMTok],
    [usage.outputTokens, pricing.outputMicroUsdPerMTok],
    [usage.cacheReadTokens ?? 0, pricing.cacheReadMicroUsdPerMTok],
    [usage.cacheWriteTokens ?? 0, pricing.cacheWriteMicroUsdPerMTok],
  ];
  let total = 0n;
  for (const [tokens, rate] of parts) {
    if (!Number.isSafeInteger(tokens) || tokens < 0) return undefined;
    if (tokens === 0) continue;
    if (!isRate(rate)) return undefined;
    total += BigInt(tokens) * BigInt(rate);
  }
  const micro = (total + 999_999n) / 1_000_000n;
  return micro <= BigInt(Number.MAX_SAFE_INTEGER) ? { microUsd: Number(micro) } : undefined;
}
