// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

/** Values are whatever string was passed in: callers pass a latin1 view of the bytes so nothing is decoded lossily.
 * One `name = value` line, with its section. Section and name are lower-cased; a quoted subsection keeps its case. */
export interface ConfigEntry {
  readonly section: string;
  readonly subsection: string | null;
  readonly name: string;
  /** null for a bare key (boolean true). */
  readonly value: string | null;
  readonly line: number;
}

export interface ParsedConfig {
  readonly entries: readonly ConfigEntry[];
  /** Lines git would reject. The file's hash still covers them. */
  readonly errors: number;
  /** More entries than `maxEntries`: the rest were counted, not kept. */
  readonly truncated: boolean;
}

const isNameStart = (c: string): boolean => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");
const isNameChar = (c: string): boolean => isNameStart(c) || (c >= "0" && c <= "9") || c === "-";
// git's own whitespace (sane_ctype isspace): space, tab, CR and LF. Not form feed or vertical tab.
const isBlank = (c: string): boolean => c === " " || c === "\t" || c === "\r";

/**
 * Parses git-config(1) syntax: `[section]`, `[section "sub"]` (with `\"` and `\\`), the legacy `[section.sub]`
 * (subsection lower-cased), keys with or without a value, double-quoted parts, the escapes `\n \t \b \" \\`,
 * a trailing backslash continuing the line, `#` and `;` comments outside quotes, a BOM, and CRLF. Written to find
 * every entry git would: a key hidden after a header on the same line, behind a continuation or behind odd spacing
 * is still returned. Linear in the input; the caller bounds the input size.
 */
export function parseGitConfig(input: string, maxEntries: number): ParsedConfig {
  const bom = input.startsWith("\u00ef\u00bb\u00bf") ? 3 : input.charCodeAt(0) === 0xfeff ? 1 : 0;
  const text = input.slice(bom).replace(/\r\n/g, "\n");
  const entries: ConfigEntry[] = [];
  let errors = 0;
  let truncated = false;
  let section: string | null = null;
  let subsection: string | null = null;
  let line = 1;
  let i = 0;
  const n = text.length;

  const skipLine = (): void => {
    while (i < n && text[i] !== "\n") i++;
  };

  while (i < n) {
    const c = text[i] as string;
    if (c === "\n") {
      line++;
      i++;
      continue;
    }
    if (isBlank(c)) {
      i++;
      continue;
    }
    if (c === "#" || c === ";") {
      skipLine();
      continue;
    }
    if (c === "[") {
      i++;
      let name = "";
      while (i < n && (isNameChar(text[i] as string) || text[i] === ".")) name += text[i++];
      let sub: string | null = null;
      let ok = name.length > 0;
      if (ok && i < n && isBlank(text[i] as string)) {
        while (i < n && isBlank(text[i] as string)) i++;
        if (text[i] === '"') {
          i++;
          sub = "";
          let closed = false;
          while (i < n && text[i] !== "\n") {
            const d = text[i] as string;
            if (d === '"') {
              closed = true;
              i++;
              break;
            }
            if (d === "\\") {
              i++;
              if (i >= n || text[i] === "\n") break;
            }
            sub += text[i++];
          }
          ok = closed;
        } else {
          ok = false;
        }
      } else if (ok && name.includes(".")) {
        const dot = name.indexOf(".");
        sub = name.slice(dot + 1).toLowerCase();
        name = name.slice(0, dot);
        ok = name.length > 0;
      }
      if (ok && text[i] === "]") {
        i++;
        section = name.toLowerCase();
        subsection = sub;
      } else {
        errors++;
        section = null;
        skipLine();
      }
      continue;
    }
    if (isNameStart(c)) {
      let key = "";
      while (i < n && isNameChar(text[i] as string)) key += text[i++];
      while (i < n && isBlank(text[i] as string)) i++;
      let value: string | null = null;
      let bad = false;
      if (text[i] === "=") {
        i++;
        while (i < n && isBlank(text[i] as string)) i++;
        value = "";
        let quoted = false;
        let keepLen = 0;
        for (; i < n; i++) {
          const d = text[i] as string;
          if (d === "\n") {
            if (quoted) bad = true;
            break;
          }
          if (d === "\\") {
            const e = text[i + 1];
            // A backslash at the very end of the file continues into the end of the file, as git reads it.
            if (e === undefined) {
              i++;
              break;
            }
            if (e === "\n") {
              line++;
              i++;
              continue;
            }
            const map: Record<string, string> = { n: "\n", t: "\t", b: "\b", '"': '"', "\\": "\\" };
            const m = e === undefined ? undefined : map[e];
            if (m === undefined) {
              bad = true;
              skipLine();
              break;
            }
            value += m;
            keepLen = value.length;
            i++;
            continue;
          }
          if (d === '"') {
            quoted = !quoted;
            keepLen = value.length;
            continue;
          }
          if (!quoted && (d === "#" || d === ";")) {
            skipLine();
            break;
          }
          value += d;
          if (quoted || !isBlank(d)) keepLen = value.length;
        }
        if (!bad) value = value.slice(0, keepLen);
      } else if (i < n && text[i] !== "\n" && text[i] !== "#" && text[i] !== ";") {
        bad = true;
        skipLine();
      } else if (text[i] === "#" || text[i] === ";") {
        skipLine();
      }
      if (section === null || bad) {
        errors++;
      } else if (entries.length >= maxEntries) {
        truncated = true;
      } else {
        entries.push({ section, subsection, name: key.toLowerCase(), value: bad ? null : value, line });
      }
      continue;
    }
    errors++;
    skipLine();
  }
  return { entries, errors, truncated };
}
