// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Reads the host's excludeDirs result defensively. Whatever the host returned or threw, the only outcome other than a
// clean list is the one fixed E_UNAVAILABLE text: nothing of the host's value or message is echoed.
import { types } from "node:util";
import { isNormalised, isPlainAbsolute, nodeFs } from "@axis/pty-policy";
import { GitOpsError } from "./errors.js";

export const BAD_EXCLUDES = "the host's excludeDirs list is not usable (it must be a plain array of at most 1024 absolute, normalised paths)";
export const MAX_EXCLUDES = 1024;

/**
 * Calls the host's function and returns a copy of its list with duplicates (by real path) removed. Accepted: a plain
 * `Array` (prototype `Array.prototype`, not a Proxy) whose own properties are only data elements `0..n-1` and `length`.
 * Refused: a Proxy, a subclass, an accessor, a hole, an extra or symbol property, a non-string, relative or unnormalised
 * entry, a throw, and more than MAX_EXCLUDES entries. Elements are read by index, once each, inside the try.
 */
export function readExcludeDirs(read: () => unknown, platform: NodeJS.Platform): string[] {
  const bad = (): GitOpsError => new GitOpsError("E_UNAVAILABLE", BAD_EXCLUDES);
  const list: string[] = [];
  try {
    const got = read();
    if (!Array.isArray(got) || types.isProxy(got) || Object.getPrototypeOf(got) !== Array.prototype) throw bad();
    const n = got.length;
    if (n > MAX_EXCLUDES) throw bad();
    const keys = Reflect.ownKeys(got);
    if (keys.length !== n + 1) throw bad(); // a hole, an extra named property or a symbol
    const seen = new Set<string>();
    for (let i = 0; i < n; i++) {
      const desc = Object.getOwnPropertyDescriptor(got, String(i));
      if (desc === undefined || !("value" in desc)) throw bad(); // an accessor or a hole
      const d: unknown = desc.value;
      if (typeof d !== "string" || !isPlainAbsolute(d, platform) || !isNormalised(d, platform)) throw bad();
      const key = nodeFs.realPath?.(d) ?? d;
      if (seen.has(key)) continue;
      seen.add(key);
      list.push(d);
    }
  } catch {
    throw bad();
  }
  return list;
}
