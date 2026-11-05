// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { contracts, lookupMethod } from "@axis/protocol";
import type { ContractRegistry } from "./types.js";

/** Token bucket with an injected clock. */
export class RateLimiter {
  #tokens: number;
  #last: number;
  constructor(
    private readonly ratePerSecond: number,
    private readonly burst: number,
    private readonly now: () => number,
  ) {
    this.#tokens = burst;
    this.#last = now();
  }
  tryTake(): boolean {
    const t = this.now();
    this.#tokens = Math.min(this.burst, this.#tokens + ((t - this.#last) * this.ratePerSecond) / 1000);
    this.#last = t;
    if (this.#tokens < 1) return false;
    this.#tokens -= 1;
    return true;
  }
}

/** The registry the product uses: `@axis/protocol`'s contract table. */
export const protocolRegistry: ContractRegistry = {
  lookup: lookupMethod,
  versions(contract) {
    const out: number[] = [];
    for (const key of Object.keys(contracts)) {
      const slash = key.lastIndexOf("/");
      if (key.slice(0, slash) === contract) out.push(Number(key.slice(slash + 1)));
    }
    return out.sort((a, b) => a - b);
  },
};
