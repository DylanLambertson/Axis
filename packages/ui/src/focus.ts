// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Focus movement rules of the own shell (OS-6), DOM-free: F6 region cycling and roving tab stops. The frame applies
// them to real elements; these functions only decide where focus goes.

/**
 * F6 and Shift+F6: the next (or previous) region in order, wrapping. With no current region (focus on the body or in
 * an unknown place), F6 goes to the first region and Shift+F6 to the last. No regions: undefined.
 */
export function nextRegion(regions: readonly string[], current: string | undefined, backwards: boolean): string | undefined {
  if (regions.length === 0) return undefined;
  const at = current === undefined ? -1 : regions.indexOf(current);
  if (at === -1) return backwards ? regions[regions.length - 1] : regions[0];
  return regions[(at + (backwards ? regions.length - 1 : 1)) % regions.length];
}

export type Orientation = "vertical" | "horizontal";

/**
 * The item a roving tab stop moves to for a key, or undefined when the key is not a movement key. Arrows move one
 * step and stop at the ends (no wrap), Home and End jump; the arrows of the other orientation are not handled.
 */
export function rovingIndex(count: number, current: number, key: string, orientation: Orientation = "vertical"): number | undefined {
  if (count <= 0) return undefined;
  const at = Math.min(Math.max(current, 0), count - 1);
  const next = orientation === "vertical" ? "ArrowDown" : "ArrowRight";
  const previous = orientation === "vertical" ? "ArrowUp" : "ArrowLeft";
  switch (key) {
    case next: return Math.min(at + 1, count - 1);
    case previous: return Math.max(at - 1, 0);
    case "Home": return 0;
    case "End": return count - 1;
    default: return undefined;
  }
}
