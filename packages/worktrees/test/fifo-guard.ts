// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Helpers for tests that race a reader against a path toggled between a file and a FIFO.

import { closeSync, constants, lstatSync, openSync, readdirSync } from 'node:fs';
import * as path from 'node:path';

/**
 * A reader blocked in open(2) on a FIFO holds a thread-pool thread for good, and Node does not exit while it is held: a regression that
 * blocks would fail its test at the per-call bound and then leave the test process running until something kills it. Opening each FIFO
 * under `roots` for writing (without blocking) lets such a reader complete, so the process can end. Call it after the togglers are
 * stopped; it never throws.
 */
export function releaseFifos(roots: readonly string[]): void {
  const visit = (dir: string, depth: number): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const full = path.join(dir, name);
      try {
        const st = lstatSync(full);
        if (st.isFIFO()) closeSync(openSync(full, constants.O_WRONLY | constants.O_NONBLOCK));
        else if (st.isDirectory() && depth < 3 && name !== '.git') visit(full, depth + 1);
      } catch {
        // The path changed or has no reader: nothing is blocked on it.
      }
    }
  };
  for (const root of roots) visit(root, 0);
}

/**
 * Rejects if `p` has not settled within `ms` (a hang becomes a failure at that bound, not a stuck run) and, when it rejects, releases
 * every FIFO under `roots` so a reader blocked on one cannot keep the process alive.
 */
export function expectNoHang<T>(p: Promise<T>, ms: number, what: string, roots: readonly string[]): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    t = setTimeout(() => {
      releaseFifos(roots);
      // A reader blocked in open(2) on a FIFO that was renamed away cannot be reached by path and holds a thread-pool thread for good: with
      // a few of them every later file system call (the file's own cleanup included) waits too, and Node never exits. The failure is
      // reported through the rejection below; this kills the process a few seconds later (process.exit would wait for those threads too), so a regression fails in
      // seconds instead of hanging until an outside timeout.
      setTimeout(() => process.kill(process.pid, 'SIGKILL'), 5000).unref();
      reject(new Error(`${what} did not settle within ${ms} ms`));
    }, ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}
