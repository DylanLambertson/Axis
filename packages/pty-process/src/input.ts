// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { PtyChild } from "./ports.js";

export const DEFAULT_INPUT_LIMITS = { terminal: 1024 * 1024, process: 8 * 1024 * 1024, entriesTerminal: 1024, entriesProcess: 8192 } as const;
export type InputLimits = { readonly terminal: number; readonly process: number; readonly entriesTerminal: number; readonly entriesProcess: number };

/** The part of a terminal the input bound reads and sets. */
export interface InputTerm {
  readonly child: PtyChild;
  /** Input was refused: every write is refused until the child has taken all it was given. */
  inputBlocked: boolean;
}

/**
 * PTY-4: whether the child (or the process as a whole) holds more unconsumed input than allowed. Checked cheapest first, and
 * every scan is bounded by the entry limits: the terminal's queue by `entriesTerminal`, all queues together by `entriesProcess`.
 * Unmeasurable counts as full. Once refused, a terminal stays refused until its queue is empty, so the writer notices; a writer that
 * is refused must abandon the rest of that input (a later chunk of the same paste would otherwise splice).
 */
/** `all` gives every terminal afresh for each scan (an iterator is consumed by the first). */
export function inputFull(t: InputTerm, all: () => Iterable<InputTerm>, limits: InputLimits): boolean {
  const block = (): true => (t.inputBlocked = true);
  try {
    const entries = t.child.pendingEntries?.();
    const bytes = (): number | undefined => t.child.pendingWrite?.();
    if (t.inputBlocked) {
      if ((entries ?? 0) > 0 || (bytes() ?? 0) > 0) return true;
      t.inputBlocked = false;
    }
    if (entries !== undefined) {
      if (!(entries <= limits.entriesTerminal)) return block();
      let totalEntries = 0;
      for (const x of all()) totalEntries += x.child.pendingEntries?.() ?? 0;
      if (!(totalEntries <= limits.entriesProcess)) return block();
    }
    const own = bytes();
    if (own === undefined) return false;
    if (!(own < limits.terminal)) return block();
    let total = 0;
    for (const x of all()) total += x.child.pendingWrite?.() ?? 0;
    return total < limits.process ? false : block();
  } catch {
    return block();
  }
}
