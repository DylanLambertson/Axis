// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { Redactor } from "@axis/audit";

const redactor = new Redactor();

// Control characters, bidirectional controls, zero-width and other invisible format characters, line and
// paragraph separators, variation selectors and the tag block. Built from numbers so the source holds no
// invisible literal.
const RANGES: readonly (readonly [number, number])[] = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x00ad, 0x00ad],
  [0x061c, 0x061c],
  [0x115f, 0x1160],
  [0x17b4, 0x17b5],
  [0x180b, 0x180f],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x206f],
  [0x3164, 0x3164],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
  [0xfff9, 0xfffc],
  [0xe0000, 0xe0fff],
];

function isInvisible(cp: number): boolean {
  for (const [lo, hi] of RANGES) if (cp >= lo && cp <= hi) return true;
  return false;
}

/** Control, bidirectional and invisible characters (and lone surrogates) become `\u{hex}`; a backslash is doubled. */
export function escapeDisplay(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let cp = c;
    let width = 1;
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        cp = (c - 0xd800) * 0x400 + (next - 0xdc00) + 0x10000;
        width = 2;
      } else {
        out += "\\u{" + c.toString(16) + "}";
        continue;
      }
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      out += "\\u{" + c.toString(16) + "}";
      continue;
    }
    if (cp === 0x5c) out += "\\\\";
    else if (isInvisible(cp)) out += "\\u{" + cp.toString(16) + "}";
    else out += width === 2 ? s.slice(i, i + 2) : s[i];
    i += width - 1;
  }
  return out;
}

/** Cuts to `max` characters without splitting a surrogate pair. */
export function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = max;
  const c = s.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end -= 1;
  return s.slice(0, end);
}

const SECRET_NAME = /(?:password|passwd|passphrase|pwd|secret|token|apikey|cookie|extraheader|bearer|signature|authorization|credentials?)$/;

/** True when a key's name ends like a secret's, whatever its value looks like. */
export function secretNamed(name: string): boolean {
  return SECRET_NAME.test(name.toLowerCase().replace(/[-_\s]/g, ""));
}

/** Pattern redaction (URL credentials, headers, token shapes, secret-named assignments, key blocks). */
export function redactText(s: string): string {
  return redactor.redactString(s);
}

/** A value shown on a single line: redacted, then escaped. */
export function displayValue(s: string, max = 400): string {
  return escapeDisplay(clip(redactText(clip(s, 16_000)), max));
}

/** A path or link target shown to the user: credentials in a URL-like path are redacted, then escaped. */
export function displayPath(s: string, max = 1024): string {
  return displayValue(s, max);
}
