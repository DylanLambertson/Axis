// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Whether the attribute files outside the tracked tree can be trusted to leave a content filter visible (design §2).
// `check-attr` reads them all, so a rule there can make an encrypted blob look plain, and none of them is in the base tree.
import { isAbsolute as posixAbs, join as posixJoin } from "node:path/posix";
import { isAbsolute as winAbs, join as winJoin } from "node:path/win32";
import type { WorktreeRef } from "@axis/git-ops";
import { OBJECT_ID, gitPaths, type ReviewGit } from "./gitcall.js";
import type { ReviewDeps, ReviewLimits } from "./types.js";

/** The content of a file read through git (the package has no file system); undefined when it could not be read whole. */
async function readThroughGit(git: ReviewGit, path: string, limits: ReviewLimits): Promise<string | undefined> {
  const h = await git(["hash-object", "-w", "--no-filters", "--", path]);
  const oid = h.stdout.trim();
  if (h.code !== 0 || !OBJECT_ID.test(oid)) return undefined;
  const body = await git(["cat-file", "blob", oid]);
  if (body.code !== 0 || body.truncated === true || body.stdout.length > limits.maxPreviewBytes) return undefined;
  return body.stdout;
}

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

/** The user-level attribute files git reads: `core.attributesFile` (or its default under XDG/HOME) and the system file when git can name it. */
async function outsideFiles(deps: ReviewDeps, git: ReviewGit, w: WorktreeRef): Promise<string[]> {
  const win = (deps.git.platform ?? process.platform) === "win32";
  const join = win ? winJoin : posixJoin;
  const abs = win ? winAbs : posixAbs;
  const env = deps.git.env.daemon;
  const found = new Set<string>();
  // Like git: `core.attributesFile` when set, otherwise the default under XDG_CONFIG_HOME or HOME (never both).
  const cfg = await git(["config", "--type=path", "--get", "core.attributesFile"]);
  const p = cfg.code === 0 ? cfg.stdout.trim().replace(/\n[\s\S]*$/, "") : "";
  if (p !== "") found.add(abs(p) ? p : join(w.workTree, p));
  else {
    const xdg = env["XDG_CONFIG_HOME"];
    const home = env["HOME"] ?? env["USERPROFILE"];
    if (xdg !== undefined && xdg !== "") found.add(join(xdg, "git", "attributes"));
    else if (home !== undefined && home !== "") found.add(join(home, ".config", "git", "attributes"));
  }
  const sys = await git(["var", "GIT_ATTR_SYSTEM"]);
  if (sys.code === 0 && sys.stdout.trim() !== "") found.add(sys.stdout.trim());
  return [...found];
}

/**
 * True when no path should be offered because an attribute source outside the tracked tree cannot be trusted:
 *  - `$GIT_DIR/info/attributes` holds any attribute line (comments and blank lines do not count): it outranks every tracked
 *    `.gitattributes`, so it can switch a filter off, directly or through a macro;
 *  - `core.attributesFile` (or the default user file) or the system file defines a macro, quoted or not: those files rank below
 *    every tracked file, so only a macro defined there (which replaces one the tree uses) can hide a filter. A line that merely
 *    names a filter does not matter and does not block;
 *  - one of those files exists and cannot be read whole.
 * Known limits: a tracked `.gitattributes` that uses a macro defined outside the tree is checked against the macro as it is
 * now; the system file is found with `git var GIT_ATTR_SYSTEM` (git 2.42 and later), so on an older git it is not checked
 * (design §2).
 */
export async function attributesUntrusted(deps: ReviewDeps, git: ReviewGit, w: WorktreeRef, limits: ReviewLimits): Promise<boolean> {
  const [info] = await gitPaths(deps, git, w, ["info/attributes"]);
  if (info !== undefined && (await deps.fileExists(info))) {
    const text = await readThroughGit(git, info, limits);
    if (text === undefined || patterns(text).length > 0) return true;
  }
  for (const path of await outsideFiles(deps, git, w)) {
    if (!(await deps.fileExists(path))) continue;
    const text = await readThroughGit(git, path, limits);
    if (text === undefined || patterns(text).some((p) => p.bad || p.pattern?.startsWith("[attr]") === true)) return true;
  }
  return false;
}
