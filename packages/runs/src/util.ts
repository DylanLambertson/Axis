// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { Clock } from "./ports.js";

export type Timed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly why: "timeout" | "error" };

/**
 * Await `work` for at most `ms`. Never rejects. The timer is cleared as soon as `work` settles, and a rejection
 * that arrives after the timeout is swallowed (it would otherwise be an unhandled rejection).
 * `work` is a thunk so a synchronous throw is also an `error`.
 */
export function timed<T>(clock: Clock, ms: number, work: () => Promise<T>): Promise<Timed<T>> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: Timed<T>): void => {
      if (done) return;
      done = true;
      clock.clearTimeout(timer);
      resolve(r);
    };
    const timer = clock.setTimeout(() => finish({ ok: false, why: "timeout" }), ms);
    let p: Promise<T>;
    try {
      p = Promise.resolve(work());
    } catch {
      finish({ ok: false, why: "error" });
      return;
    }
    p.then(
      (value) => finish({ ok: true, value }),
      () => finish({ ok: false, why: "error" }),
    );
  });
}

/** Folded form of a path for "is this the same worktree" questions. A false match only refuses; it never allows. */
export function pathKey(p: string): string {
  return p.normalize("NFC").toLowerCase().replace(/\\/g, "/").replace(/\/+$/, "");
}

export const noControl = (s: string): boolean => !/[\u0000-\u001f\u007f]/.test(s);
