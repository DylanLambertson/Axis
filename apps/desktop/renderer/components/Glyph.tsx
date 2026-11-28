// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// A status glyph: one shape per state (directions.md section 8 item 2), never the only cue. It is decorative to
// assistive technology; the text beside it carries the meaning.

export type GlyphKind = "run" | "wait" | "bad" | "ok" | "quiet" | "idle" | "info" | "warn";

export function Glyph({ kind }: { readonly kind: GlyphKind }) {
  return <span className={`axis-g axis-g--${kind}`} aria-hidden="true" />;
}
