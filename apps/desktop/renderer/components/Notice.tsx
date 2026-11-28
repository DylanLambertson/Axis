// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The notice banner above a screen: a glyph, a severity word for screen readers and the sentence. Errors interrupt
// (role="alert"); warnings and information are polite (role="status").

import type { AxisNoticeSeverity, IAxisNotice } from "@axis/shell-core";
import { Glyph, type GlyphKind } from "./Glyph.js";

const GLYPH: Readonly<Record<AxisNoticeSeverity, GlyphKind>> = { error: "bad", warning: "warn", info: "info" };
const WORD: Readonly<Record<AxisNoticeSeverity, string>> = { error: "Error:", warning: "Warning:", info: "Note:" };

export function Notice({ notice }: { readonly notice: IAxisNotice }) {
  return (
    <div className={`axis-notice axis-notice--${notice.severity}`} role={notice.severity === "error" ? "alert" : "status"}>
      <Glyph kind={GLYPH[notice.severity]} />
      <p>
        <span className="axis-sr">{WORD[notice.severity]} </span>
        {notice.text}
      </p>
    </div>
  );
}

export function Notices({ notices }: { readonly notices: readonly IAxisNotice[] }) {
  if (notices.length === 0) return null;
  return (
    <div className="axis-notices">
      {notices.map((n, i) => (
        <Notice key={i} notice={n} />
      ))}
    </div>
  );
}
