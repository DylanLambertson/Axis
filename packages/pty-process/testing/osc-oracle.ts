// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

/** One OSC the xterm.js parser would start a handler for (or would have, had it not been aborted), with its numeric id. */
export interface OscSeen {
  readonly id: number;
}

const isIgnorable = (c: number): boolean => (c <= 0x17 && c !== 0x07) || c === 0x19 || (c >= 0x1c && c <= 0x1f);

/**
 * TEST ONLY: a small independent model of how xterm.js (`EscapeSequenceParser` and `OscParser`) finds OSC sequences, written
 * from its transition table rather than from the filter. It reports the id of every OSC that starts (ends, aborts or is cut off
 * by the end of the input all count, which is stricter than xterm's handler calls). An id is the digits before the first `;`
 * read as an integer (`0633` is 633); ignorable C0 controls are skipped; a printable non-digit makes xterm ignore the sequence.
 */
export function oscIds(input: string): number[] {
  const seen: number[] = [];
  let state = "ground" as "ground" | "escape" | "osc";
  let id = -1;
  let inId = false;
  const finish = (): void => {
    if (inId && id !== -1) seen.push(id);
    inId = false;
  };
  const start = (): void => {
    if (state === "osc") finish();
    state = "osc";
    id = -1;
    inId = true;
  };
  for (const ch of input) {
    const c = ch.codePointAt(0) as number;
    if (state === "osc") {
      if (c === 0x9d) start();
      else if (c === 0x07 || c === 0x9c || c === 0x1b || c === 0x18 || c === 0x1a || (c >= 0x80 && c <= 0x9f)) {
        finish();
        state = c === 0x1b ? "escape" : "ground";
      } else if (isIgnorable(c)) continue;
      else if (inId) {
        if (c === 0x3b) {
          if (id !== -1) seen.push(id);
          inId = false;
        } else if (c >= 0x30 && c <= 0x39) id = Math.min(1e9, (id === -1 ? 0 : id) * 10 + c - 0x30);
        else inId = false; // xterm ignores the rest of the sequence
      }
      continue;
    }
    if (c === 0x1b) state = "escape";
    else if (c === 0x9d) start();
    else if (state === "escape") {
      if (c === 0x5d) start();
      else if (!(isIgnorable(c) || c === 0x07 || c === 0x7f)) state = "ground";
    }
  }
  finish();
  return seen;
}
