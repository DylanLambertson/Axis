// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Platform-aware path rules. Pure string logic; no file system access.
import * as posix from "node:path/posix";
import * as win32 from "node:path/win32";

const DRIVE_ABS = /^[A-Za-z]:[\\/]/;

/**
 * An absolute path in the platform's own form. On win32 only a drive-letter path counts: UNC (`\\host\share`,
 * `//host/share`), device (`\\?\`, `\\.\`) and root-relative (`\x`) paths are refused, because a UNC executable or
 * root runs code from a network share and leaks credentials at launch.
 */
export function isPlainAbsolute(p: string, platform: NodeJS.Platform): boolean {
  if (typeof p !== "string" || p.length === 0 || p.includes("\0")) return false;
  return platform === "win32" ? DRIVE_ABS.test(p) : posix.isAbsolute(p);
}

export function hasDotDot(p: string): boolean {
  return p.split(/[\\/]+/).includes("..");
}

/** True when the path is already in normal form (no `.` or `..` segments, no doubled separators). */
export function isNormalised(p: string, platform: NodeJS.Platform): boolean {
  const norm = platform === "win32" ? win32.normalize(p) : posix.normalize(p);
  const trim = (s: string): string => s.replace(/[\\/]+$/, "");
  return trim(norm) === trim(p);
}

function fold(p: string, platform: NodeJS.Platform): string {
  const n = platform === "win32" ? win32.normalize(p).replace(/\//g, "\\").toLowerCase() : posix.normalize(p);
  const sep = platform === "win32" ? "\\" : "/";
  return n.endsWith(sep) ? n : n + sep;
}

/** True when `p` is `dir` or lies below it. Case-insensitive on win32. */
export function isInside(p: string, dir: string, platform: NodeJS.Platform): boolean {
  return fold(p, platform).startsWith(fold(dir, platform));
}

export function delimiterOf(platform: NodeJS.Platform): string {
  return platform === "win32" ? ";" : ":";
}

export function joinPath(dir: string, name: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? win32.join(dir, name) : posix.join(dir, name);
}
