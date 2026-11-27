// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The one place for the product name and the other user-visible brand strings of the own shell (rebrand
// readiness, docs/design/rebrand-readiness.md): main's window titles and dialogs and the renderer's copy take them
// from here, never from a literal. Internal ids (the app id, the user-data folder name, wire and storage names) are
// NOT brand strings and do not live here: they stay stable across a rename.

export interface Brand {
  /** The product name as people read it: window titles, dialogs, the about text. */
  readonly productName: string;
  /** A one-line description for the about text and the platform's application metadata. */
  readonly tagline: string;
}

export const BRAND: Brand = Object.freeze({
  productName: "Axis",
  tagline: "A desktop workspace for supervised coding runs.",
});

/** A window title: the page's own title first, then the product name; the product name alone when there is none. */
export function windowTitle(page?: string): string {
  const trimmed = page?.trim() ?? "";
  return trimmed === "" ? BRAND.productName : `${trimmed} - ${BRAND.productName}`;
}
