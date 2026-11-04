// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// WT-1, lexical stage: pure string rules, parameterised by platform so every platform's rules run on every host.
import * as posix from "node:path/posix";
import * as win32 from "node:path/win32";
import { denied, type Reason } from "./errors.js";

export const MAX_PATH_CHARS = 4096;
const MAX_SEGMENT_BYTES = 255;
// eslint-disable-next-line no-control-regex
const CONTROL = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]");
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const RESERVED_WIN = /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/i;

const fail = (reason: Reason): never => {
  throw denied(reason, "the path is not allowed");
};

/** Names compare case- and normalisation-insensitively where the default file systems do (win32, darwin). */
export function caseInsensitive(platform: NodeJS.Platform): boolean {
  return platform === "win32" || platform === "darwin";
}

export function foldName(name: string, platform: NodeJS.Platform): string {
  return caseInsensitive(platform) ? name.normalize("NFC").toLowerCase() : name;
}

export const splitNative = (p: string, platform: NodeJS.Platform): string[] =>
  p.split(platform === "win32" ? /[\\/]+/ : /\/+/).filter((s) => s !== "");

/**
 * The segments of `input` below `root`. `root` is the canonical root in the platform's own form.
 * Refused on every platform: `..`, NUL and control characters, lone surrogates, backslashes (non-win32), drive
 * prefixes (non-win32). On win32 also UNC and device paths, drive-relative paths, `:` (alternate data streams),
 * reserved device names, trailing dots or spaces and 8.3 short names. An absolute path must lie under `root`.
 */
export function lexicalSegments(input: unknown, root: string, platform: NodeJS.Platform): string[] {
  if (typeof input !== "string" || input.length === 0 || input.length > MAX_PATH_CHARS) return fail("invalid-path");
  if (CONTROL.test(input) || LONE_SURROGATE.test(input)) return fail("invalid-path");
  const win = platform === "win32";
  if (!win) {
    if (input.includes("\\")) return fail("backslash");
    if (/^[A-Za-z]:/.test(input)) return fail("drive-prefix");
  } else {
    if (/^[\\/]{2}/.test(input)) return fail("unc-or-device");
    if (/^[A-Za-z]:(?![\\/])/.test(input)) return fail("drive-prefix");
  }
  const parts = input.split(win ? /[\\/]/ : "/");
  if (parts.some((s) => s === "..")) return fail("dotdot");
  const absolute = win ? /^[A-Za-z]:[\\/]/.test(input) : input.startsWith("/");
  let segs = parts.filter((s) => s !== "" && s !== ".");
  if (absolute) {
    // Compare with the root in normalised form; the real-path stage decides whether the spelling is the truth.
    const lib = win ? win32 : posix;
    const rootSegs = splitNative(lib.normalize(root), platform);
    const inSegs = splitNative(lib.normalize(input), platform);
    if (inSegs.length < rootSegs.length) return fail("outside-root");
    for (let i = 0; i < rootSegs.length; i++) {
      if (foldName(inSegs[i] as string, platform) !== foldName(rootSegs[i] as string, platform)) return fail("outside-root");
    }
    segs = inSegs.slice(rootSegs.length);
  }
  for (const s of segs) {
    if (Buffer.byteLength(s, "utf8") > MAX_SEGMENT_BYTES) return fail("invalid-path");
    if (!win) continue;
    if (/[<>:"|?*]/.test(s)) return fail("win-name");
    if (/[. ]$/.test(s) || RESERVED_WIN.test(s) || /~\d/.test(s)) return fail("win-name");
  }
  return segs;
}

/** A relative POSIX spelling of segments, `.` for the root itself (what git pathspecs and audit text use). */
export const relText = (segs: readonly string[]): string => (segs.length === 0 ? "." : segs.join("/"));
