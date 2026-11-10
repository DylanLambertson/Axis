// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Whether the attribute files outside the tracked tree can be trusted to leave a content filter visible (design §2).
// `check-attr` reads them all, so a rule there can make an encrypted blob look plain, and none of them is in the base tree.
// They are read ONCE, into the private git directory of @axis/git-ops' `attributeReadGit`, and judged on those exact bytes:
// every `check-attr` read runs there, so a file written after the snapshot changes nothing (REV2-FIX, RR-13).
import { isAbsolute as posixAbs, join as posixJoin } from "node:path/posix";
import { isAbsolute as winAbs, join as winJoin } from "node:path/win32";
import { GitOpsError, attributeReadGit, type AttributeRead, type WorktreeRef } from "@axis/git-ops";
import type { ReviewGit } from "./gitcall.js";
import type { ReviewDeps } from "./types.js";

/**
 * The pattern of an attribute line the way git reads it (attr.c `parse_attr_line`): leading white space is skipped; a blank line
 * or one starting with `#` has none; a pattern starting with `"` is a C-style quoted string (so `"\133attr]x"` is `[attr]x`);
 * otherwise the pattern runs to the first white space. A quoted pattern that git could not decode is returned as `undefined`
 * with `bad: true`, which callers treat as a macro (fail closed).
 */
export function attributePattern(line: string): { readonly pattern: string | undefined; readonly bad: boolean } {
  const t = line.replace(/^\s+/, "");
  if (t === "" || t.startsWith("#")) return { pattern: undefined, bad: false };
  if (!t.startsWith('"')) return { pattern: t.split(/\s/, 1)[0] ?? "", bad: false };
  const bytes: number[] = [];
  const esc: Record<string, number> = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, "\\": 92, '"': 34 };
  for (let i = 1; i < t.length; i++) {
    const c = t[i] as string;
    if (c === '"') return { pattern: Buffer.from(bytes).toString("latin1"), bad: false };
    if (c !== "\\") {
      bytes.push(...Buffer.from(c, "utf8"));
      continue;
    }
    const n = t[++i];
    if (n !== undefined && esc[n] !== undefined) bytes.push(esc[n] as number);
    else if (n !== undefined && /^[0-3]$/.test(n) && /^[0-7]{2}$/.test(t.slice(i + 1, i + 3))) {
      bytes.push(parseInt(t.slice(i, i + 3), 8));
      i += 2;
    } else return { pattern: undefined, bad: true };
  }
  return { pattern: undefined, bad: true };
}

function patterns(text: string): { readonly pattern: string | undefined; readonly bad: boolean }[] {
  return text.split(/\r?\n/).map(attributePattern).filter((p) => p.pattern !== undefined || p.bad);
}

/** The user-level attribute file git reads (`core.attributesFile`, or its default under XDG/HOME) and the system file when git can name it. */
async function outsideFiles(deps: ReviewDeps, git: ReviewGit, w: WorktreeRef): Promise<{ user?: string; system?: string }> {
  const win = (deps.git.platform ?? process.platform) === "win32";
  const join = win ? winJoin : posixJoin;
  const abs = win ? winAbs : posixAbs;
  const env = deps.git.env.daemon;
  let user: string | undefined;
  // Like git: `core.attributesFile` when set, otherwise the default under XDG_CONFIG_HOME or HOME (never both).
  const cfg = await git(["config", "--type=path", "--get", "core.attributesFile"]);
  const p = cfg.code === 0 ? cfg.stdout.trim().replace(/\n[\s\S]*$/, "") : "";
  if (p !== "") user = abs(p) ? p : join(w.workTree, p);
  else {
    const xdg = env["XDG_CONFIG_HOME"];
    const home = env["HOME"] ?? env["USERPROFILE"];
    if (xdg !== undefined && xdg !== "") user = join(xdg, "git", "attributes");
    else if (home !== undefined && home !== "") user = join(home, ".config", "git", "attributes");
  }
  const sys = await git(["var", "GIT_ATTR_SYSTEM"]);
  const system = sys.code === 0 ? sys.stdout.trim() : "";
  return { ...(user === undefined ? {} : { user }), ...(system !== "" && abs(system) ? { system } : {}) };
}

/** `read` is open (call its `dispose()`) exactly when the snapshot is trusted; `untrusted` paths are never offered. */
export type AttributeSnapshot = { readonly untrusted: true; readonly read?: undefined } | { readonly untrusted: false; readonly read: AttributeRead };

/**
 * Takes the snapshot every `check-attr` read then uses, and judges it:
 *  - `$GIT_DIR/info/attributes` holds any attribute line (comments and blank lines do not count): it outranks every tracked
 *    `.gitattributes`, so it can switch a filter off, directly or through a macro;
 *  - `core.attributesFile` (or the default user file) or the system file defines a macro, quoted or not: those files rank below
 *    every tracked file, so only a macro defined there (which replaces one the tree uses) can hide a filter. A line that merely
 *    names a filter does not block: the reads see it, from the snapshot;
 *  - a source cannot be snapshotted (not a regular file, larger than git-ops' bound, unreadable): untrusted, never skipped.
 * Because git reads exactly the judged bytes, a source swapped after this call (even one restored before the review ends) is
 * not seen (RR-13). Known limits: a tracked `.gitattributes` that uses a macro defined outside the tree is checked against the
 * macro as it is now; deleting a filter that only the user's file sets makes the stored file look unfiltered; the system file is
 * found with `git var GIT_ATTR_SYSTEM` (git 2.42 and later): on an older git it is not snapshotted and, since the reads set
 * `GIT_ATTR_NOSYSTEM`, a filter only it sets is not seen.
 */
export async function snapshotAttributes(deps: ReviewDeps, git: ReviewGit, w: WorktreeRef, objectFormat: "sha1" | "sha256"): Promise<AttributeSnapshot> {
  const files = await outsideFiles(deps, git, w);
  let read: AttributeRead;
  try {
    read = await attributeReadGit(w, deps.git, {
      objectFormat,
      ...(files.user === undefined ? {} : { userAttributesFile: files.user }),
      ...(files.system === undefined ? {} : { systemAttributesFile: files.system }),
    });
  } catch (e) {
    if (e instanceof GitOpsError) return { untrusted: true };
    throw e;
  }
  const info = patterns(read.infoAttributes).length > 0;
  const outside = patterns(read.outsideAttributes).some((p) => p.bad || p.pattern?.startsWith("[attr]") === true);
  if (info || outside) {
    read.dispose();
    return { untrusted: true };
  }
  return { untrusted: false, read };
}
