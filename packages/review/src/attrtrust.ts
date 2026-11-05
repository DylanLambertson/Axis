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

function lines(text: string): string[] {
  return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("#"));
}

/** The user-level attribute files git reads: `core.attributesFile` (or its default under XDG/HOME) and the system file when git can name it. */
async function outsideFiles(deps: ReviewDeps, git: ReviewGit, w: WorktreeRef): Promise<string[]> {
  const win = (deps.git.platform ?? process.platform) === "win32";
  const join = win ? winJoin : posixJoin;
  const abs = win ? winAbs : posixAbs;
  const env = deps.git.env.daemon;
  const found = new Set<string>();
  const cfg = await git(["config", "--type=path", "--get", "core.attributesFile"]);
  if (cfg.code === 0 && cfg.stdout.trim() !== "") {
    const p = cfg.stdout.trim().replace(/\n[\s\S]*$/, "");
    found.add(abs(p) ? p : join(w.workTree, p));
  }
  const xdg = env["XDG_CONFIG_HOME"];
  const home = env["HOME"] ?? env["USERPROFILE"];
  if (xdg !== undefined && xdg !== "") found.add(join(xdg, "git", "attributes"));
  else if (home !== undefined && home !== "") found.add(join(home, ".config", "git", "attributes"));
  const sys = await git(["var", "GIT_ATTR_SYSTEM"]);
  if (sys.code === 0 && sys.stdout.trim() !== "") found.add(sys.stdout.trim());
  return [...found];
}

/**
 * True when no path should be offered because an attribute source outside the tracked tree cannot be trusted:
 *  - `$GIT_DIR/info/attributes` holds any attribute line (comments and blank lines do not count): it has the highest priority
 *    and can switch a filter off, directly or through a macro;
 *  - `core.attributesFile`, the default user file or the system file defines a macro (`[attr]`) or names a filter: a macro there
 *    can redefine one the tracked tree uses;
 *  - one of those files exists and cannot be read whole.
 * Known limit: a tracked `.gitattributes` that uses a macro defined outside the tree is checked against the macro as it is now
 * (design §2).
 */
export async function attributesUntrusted(deps: ReviewDeps, git: ReviewGit, w: WorktreeRef, limits: ReviewLimits): Promise<boolean> {
  const [info] = await gitPaths(deps, git, w, ["info/attributes"]);
  if (info !== undefined && (await deps.fileExists(info))) {
    const text = await readThroughGit(git, info, limits);
    if (text === undefined || lines(text).length > 0) return true;
  }
  for (const path of await outsideFiles(deps, git, w)) {
    if (!(await deps.fileExists(path))) continue;
    const text = await readThroughGit(git, path, limits);
    if (text === undefined || lines(text).some((l) => l.startsWith("[attr]") || /filter/i.test(l))) return true;
  }
  return false;
}
