// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

/**
 * How much slower than an idle machine a time budget in these tests may let a run be. A budget here guards a defect that costs seconds
 * to minutes (a rescan of the whole input per character, an exponential walk); a loaded host that runs several suites at once is
 * several times slower than an idle one and must not trip it. Every widened budget still sits far below the time its defect takes.
 */
export const LOAD_MARGIN = 6;

/** A time budget in milliseconds for an idle machine, widened by `LOAD_MARGIN`. */
export const budget = (idleMs: number): number => idleMs * LOAD_MARGIN;
