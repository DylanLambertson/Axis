// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

/** A NUL ends a C string: a native binding would truncate the value silently, so it is refused. */
export const hasNul = (s: string): boolean => s.includes("\0");

/**
 * Whether `p` is an absolute path on `platform`: `/x` on POSIX; `C:\x`, `C:/x` or a UNC path (`\\server\share`) on win32.
 * A drive-relative path (`C:x`), a rooted-without-drive path (`\x`) and a relative path are not absolute. Pure: no file system.
 */
export function isAbsolutePath(p: string, platform: NodeJS.Platform): boolean {
  if (p === "" || hasNul(p)) return false;
  if (platform !== "win32") return p.startsWith("/");
  return /^[A-Za-z]:[\\/]/.test(p) || /^\\\\[^\\/?.][^\\/]*\\[^\\/]+/.test(p) || /^\\\\[?.]\\/.test(p);
}
