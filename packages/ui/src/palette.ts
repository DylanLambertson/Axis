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
