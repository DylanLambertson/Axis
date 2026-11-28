// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The command palette's matching (OS-6), DOM-free: which commands a query shows, in which order, and where the
// selection moves. The palette component applies it; the registry stays the one source of titles and chords.

/** What the palette needs of a command. */
export interface PaletteItem {
  readonly id: string;
  readonly title: string;
}

/**
 * The items a query shows: every whitespace-separated term must appear in the title, ignoring case. Titles that start
 * with the first term come first; otherwise the given order (the registry's, by title) is kept. An empty query shows all.
 */
export function filterCommands<T extends PaletteItem>(items: readonly T[], query: string): readonly T[] {
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t !== "");
  if (terms.length === 0) return items;
  const hits = items.filter((item) => {
    const title = item.title.toLowerCase();
    return terms.every((t) => title.includes(t));
  });
  const first = terms[0]!;
  return [...hits.filter((i) => i.title.toLowerCase().startsWith(first)), ...hits.filter((i) => !i.title.toLowerCase().startsWith(first))];
}

/** The part of a DOM `KeyboardEvent` the palette reads. */
export interface PaletteKey {
  readonly key: string;
  /** The event's own `isComposing`, or a composition the input saw start and not yet end (`compositionstart`). */
  readonly isComposing: boolean;
  /** The legacy `keyCode`: 229 marks a key an input method is handling, even when `isComposing` is false. */
  readonly keyCode: number;
  readonly repeat: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

/** The `keyCode` Chromium gives a key an input method handles. */
const IME_KEY_CODE = 229;

/** What a key in the palette does: nothing (left to the input or the page), close, keep focus, run, swallow, move. */
export type PaletteKeyAction = "none" | "close" | "hold" | "run" | "swallow" | "next" | "previous";

/**
 * The palette's reading of a key, before it acts. A key that completes or edits input-method text belongs to the input
 * method, so nothing happens, not even Escape: `isComposing` (the event's flag or a composition still open on the input),
 * keyCode 229, and Chromium's "Process" key, which is no palette key either. Only an unmodified Enter runs, and never a
 * repeat: a held Enter that opened the palette must not also choose. Tab (with or without Shift) keeps focus in the
 * input. Arrows move, repeats included.
 */
export function paletteKeyAction(event: PaletteKey): PaletteKeyAction {
  if (event.isComposing || event.keyCode === IME_KEY_CODE) return "none";
  const modified = event.ctrlKey || event.metaKey || event.altKey || event.shiftKey;
  switch (event.key) {
    case "Tab":
      return "hold";
    case "Escape":
      return modified ? "none" : "close";
    case "Enter":
      return modified ? "none" : event.repeat ? "swallow" : "run";
    case "ArrowDown":
      return modified ? "none" : "next";
    case "ArrowUp":
      return modified ? "none" : "previous";
    default:
      return "none";
  }
}

/**
 * The active option after a key in the palette's input, or undefined when the key does not move it. ArrowDown and
 * ArrowUp wrap (the list is short and the input keeps focus); Home and End stay with the input's text, so they are not
 * handled here.
 */
export function paletteMove(count: number, active: number, key: string): number | undefined {
  if (count <= 0) return undefined;
  if (key === "ArrowDown") return active < 0 ? 0 : (active + 1) % count;
  if (key === "ArrowUp") return active < 0 ? count - 1 : (active + count - 1) % count;
  return undefined;
}
