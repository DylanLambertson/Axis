// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The smoke report (apps/desktop/smoke): when AXIS_DESKTOP_SMOKE=1, main waits for the renderer to mount, prints one
// line `AXIS_DESKTOP_SMOKE <json>` and quits. It reads the window's title and two facts from the page's main world:
// that the frame mounted, and whether any Node global is visible there (it must not be).

export const SMOKE_MARKER = "AXIS_DESKTOP_SMOKE";

/** Evaluated in the page's main world. */
export const PAGE_PROBE =
  "({ mounted: document.documentElement.dataset.axisShell === 'mounted', node: typeof require !== 'undefined' || typeof process !== 'undefined' || typeof module !== 'undefined' })";

export interface SmokeReport {
  readonly mounted: boolean;
  readonly title: string;
  readonly nodeInPage: boolean;
}

export interface SmokeTarget {
  readonly title: () => string;
  /** The PAGE_PROBE result; anything else reads as not mounted with Node visible. */
  readonly probe: () => Promise<unknown>;
  readonly wait: (ms: number) => Promise<void>;
}

function read(value: unknown): { mounted: boolean; node: boolean } {
  if (typeof value !== "object" || value === null) return { mounted: false, node: true };
  const v = value as Record<string, unknown>;
  return { mounted: v.mounted === true, node: v.node !== false };
}

/** Polls until the page says it mounted (at most `tries` times), then reports what the last probe saw. */
export async function smokeReport(target: SmokeTarget, tries = 100, intervalMs = 100): Promise<SmokeReport> {
  let seen = { mounted: false, node: true };
  for (let i = 0; i < tries; i++) {
    seen = read(await target.probe());
    if (seen.mounted) break;
    await target.wait(intervalMs);
  }
  return { mounted: seen.mounted, title: target.title(), nodeInPage: seen.node };
}

export function smokeLine(report: SmokeReport): string {
  return `${SMOKE_MARKER} ${JSON.stringify(report)}`;
}
