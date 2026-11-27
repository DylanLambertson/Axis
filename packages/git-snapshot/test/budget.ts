// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

/**
 * How much slower than an idle machine a test may run before a time budget fails it. These budgets exist to catch work that is
 * unbounded or quadratic (a hang, a FIFO read that never ends, a 100 000 path list handled in minutes); a loaded host running
 * several suites at once is several times slower than an idle one and must not trip them. The margin keeps every budget far below
 * the time such a defect takes (the hung-git test sleeps 30 s, a blocked FIFO never returns).
 */
export const LOAD_MARGIN = 6;

/** A time budget in milliseconds for an idle machine, widened by `LOAD_MARGIN`. */
export const budget = (idleMs: number): number => idleMs * LOAD_MARGIN;
