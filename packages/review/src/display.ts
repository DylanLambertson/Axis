// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// FT-1 and DASH-1: untrusted strings (paths, hunk text, link targets) are escaped before any UI sees them, and
// repository paths are judged before they can be used. Pure functions; none of them throws.

export interface EscapeOptions {
  /** Output is cut after this many code points, with an ellipsis. Default 512. */
  readonly maxLength?: number;
  /** Keep U+0009 as a tab (hunk text). Paths always escape it. */
  readonly keepTab?: boolean;
  /**
   * Where a too-long text is cut. "end" (default) keeps the start. "middle" keeps the start and the last two thirds, which is
   * what a path needs: the file name is at the end and is the part a reviewer must not lose.
   */
  readonly cut?: "end" | "middle";
  /** Append U+2026 to a cut text (default true). Hunk lines turn it off: they carry an explicit `truncated` flag instead. */
  readonly ellipsis?: boolean;
}

export interface EscapedText {
  readonly text: string;
  /** The input was longer than `maxLength` and part of it is not in `text`. */
  readonly truncated: boolean;
}

const NAMED: Readonly<Record<number, string>> = { 0x0a: "\\n", 0x0d: "\\r", 0x09: "\\t", 0x5c: "\\\\" };

/** Controls, invisible and direction-changing code points that can make text read differently from what it is. */
function mustEscape(cp: number): boolean {
  return (
    cp < 0x20 || (cp >= 0x7f && cp <= 0x9f) || cp === 0xad || cp === 0x061c || cp === 0x115f || cp === 0x1160 || cp === 0x180e ||
    (cp >= 0x200b && cp <= 0x200f) || (cp >= 0x2028 && cp <= 0x202e) || (cp >= 0x2060 && cp <= 0x206f) || cp === 0x3164 ||
    (cp >= 0xd800 && cp <= 0xdfff) || (cp >= 0xfdd0 && cp <= 0xfdef) || cp === 0xfeff || cp === 0xffa0 || (cp >= 0xfff9 && cp <= 0xfffb) ||
    (cp & 0xfffe) === 0xfffe || (cp >= 0xe0000 && cp <= 0xe0fff)
  );
}

/** One code point as text: escaped when it could mislead, a backslash doubled so the output is unambiguous. */
function show(cp: number, keepTab: boolean): string {
  if (cp === 0x09 && keepTab) return "\t";
  const named = NAMED[cp];
  if (named !== undefined) return named;
  if (!mustEscape(cp)) return String.fromCodePoint(cp);
  return cp < 0x100 ? `\\x${cp.toString(16).padStart(2, "0")}` : `\\u{${cp.toString(16)}}`;
}

export function escapeForDisplay(input: string, opts: EscapeOptions = {}): string {
  return escapeWithInfo(input, opts).text;
}

export function escapeWithInfo(input: string, opts: EscapeOptions = {}): EscapedText {
  const mark = opts.ellipsis === false ? "" : "\u2026";
  const text = typeof input === "string" ? input : "";
  const max = Math.max(1, Math.floor(opts.maxLength ?? 512));
  const keepTab = opts.keepTab === true;
  if (opts.cut === "middle") {
    const tail = Math.max(1, Math.floor((max * 2) / 3));
    const head = Math.max(1, max - tail);
    const render = (cps: readonly string[]): string => cps.map((c) => show(c.codePointAt(0) as number, keepTab)).join("");
    // Work is bounded by `max`, not by the input: only the two ends of a huge text are ever looked at. A pair split by
    // the cut becomes a lone surrogate, which is shown escaped.
    const whole = text.length <= max * 2 ? Array.from(text) : undefined;
    if (whole && whole.length <= max) return { text: render(whole), truncated: false };
    const start = whole ? whole.slice(0, head) : Array.from(text.slice(0, head * 2)).slice(0, head);
    const end = whole ? whole.slice(whole.length - tail) : Array.from(text.slice(text.length - tail * 2)).slice(-tail);
    return { text: `${render(start)}${mark}${render(end)}`, truncated: true };
  }
  let out = "";
  let n = 0;
  // Iterating by code point yields a lone surrogate as itself, which `show` then writes as \u{d800}.
  for (const ch of text) {
    if (n >= max) return { text: `${out}${mark}`, truncated: true };
    out += show(ch.codePointAt(0) as number, keepTab);
    n++;
  }
  return { text: out, truncated: false };
}

const WINDOWS_DRIVE = /^[A-Za-z]:/;

/** Why a repository-relative path may not be used, or undefined when it is acceptable. */
export function pathProblem(p: string): string | undefined {
  if (typeof p !== "string" || p.length === 0) return "empty";
  if (p.length > 4096) return "too_long";
  if (p.includes("\0")) return "nul";
  // The runner decodes git's output as UTF-8 and replaces what is not valid with U+FFFD, so distinct byte paths (`a\xff`, `a\xfe`)
  // can arrive as one string. Such a path cannot be told from another, so it is unusable (a file really named with U+FFFD is too).
  if (p.includes("\ufffd")) return "not_utf8";
  if (p.startsWith("/") || p.startsWith("\\") || WINDOWS_DRIVE.test(p)) return "absolute";
  for (const seg of p.split("/")) {
    if (seg === "") return "empty_segment";
    if (seg === "." || seg === "..") return "dot_segment";
    if (seg.includes("\\")) return "backslash";
    // .git, `.git.`, `.git ` and the 8.3 names name the repository directory on some file systems. NTFS also reads
    // `.git:stream` as `.git`, and HFS+ ignores some zero-width code points, as git's own path check does. A ":" elsewhere
    // in a name is an ordinary POSIX file name (`12:30 notes.md`) and is not refused.
    const core = seg.split(":")[0]?.replace(/[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g, "").replace(/[. ]+$/, "").toLowerCase();
    if (core === ".git" || core === "git~1") return "git_dir";
    if (core === "gitmod~1") return "git_dir";
  }
  return undefined;
}

const ROOTED = /^(?:[\\/]|[A-Za-z]:)/;

/**
 * Whether a symlink target leaves the worktree, judged on the text alone (nothing is ever dereferenced). Absolute,
 * drive-letter and UNC targets, an empty or NUL-bearing one, and a normalised `..` that climbs above the repository
 * root from the link's own directory all count. A link inside the tree is not a promise about what it reaches
 * through other links, which is why no consumer follows one.
 */
export function symlinkEscapes(linkPath: string, target: string): boolean {
  if (target.length === 0 || target.includes("\0") || ROOTED.test(target)) return true;
  let depth = linkPath.split("/").length - 1;
  for (const seg of target.split(/[\\/]+/)) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      depth--;
      if (depth < 0) return true;
    } else depth++;
  }
  return false;
}
