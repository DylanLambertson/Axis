// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { worktreeFailure } from "./errors.js";
import { isInside } from "./locator.js";

/**
 * A repository-relative path of a restore request, checked against the disk before anything is written (DMN-2). The
 * contract schema already refuses absolute, drive, `..`, empty, backslash, `.git` and control-character paths; this is the
 * layer that the schema cannot be: a symlink a CLI run planted inside the workspace. Every component under the workspace
 * root is `lstat`ed: no PARENT may be a symlink (a link to another workspace, to the outside, to the `.git` directory, or a
 * dangling one) and the deepest existing parent must resolve inside the real workspace root; the LEAF may be a symlink (it is
 * replaced, never followed) unless it points at a directory.
 * A component that does not exist ends the walk (the manager creates missing folders with its own checks).
 * Every refusal is the same closed `E_INVALID_ARGUMENT` (`unsafe_path`): nothing about the layout is revealed.
 * Residual, stated honestly: this is a point-in-time check. A process that a finished run left behind can flip a parent between a
 * real folder and a link to another workspace while a restore runs. The manager's `expectedWorktree` check narrows the window
 * and refuses what it can see, but Node has no descriptor-relative open, so it does not close it: in 2 of 3 reviewer runs a
 * temp file with the restored content landed in the other workspace (the other workspace's own file was never replaced).
 * DMN-2 therefore holds for every case without such a concurrent process; see docs/security/threat-model-phase1.md.
 */
export async function assertSafeRestorePath(workTree: string, rel: string, platform: NodeJS.Platform): Promise<void> {
  const refuse = (): Error => worktreeFailure("E_INVALID_ARGUMENT", "unsafe_path");
  if (typeof rel !== "string" || rel === "" || rel.includes("\0") || rel.includes("\\") || rel.startsWith("/") || path.isAbsolute(rel)) throw refuse();
  const parts = rel.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) throw refuse();
  let realRoot: string;
  try {
    realRoot = await fs.realpath(workTree);
  } catch {
    throw refuse();
  }
  let cur = workTree;
  let existing = workTree;
  for (const [i, part] of parts.entries()) {
    cur = path.join(cur, part);
    let st;
    try {
      st = await fs.lstat(cur);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") break;
      throw refuse();
    }
    if (i < parts.length - 1) {
      // A parent is followed by every later step, so it must be a real directory.
      if (st.isSymbolicLink() || !st.isDirectory()) throw refuse();
      existing = cur;
    } else if (st.isSymbolicLink()) {
      // The leaf is replaced, never followed (the manager renames a temp file over the entry): a run that swapped a file for a
      // link, or a tracked symlink, can be restored. A link to a DIRECTORY is refused (it would be replaced by a file the
      // user did not mean), a dangling or file link is fine.
      const target = await fs.stat(cur).catch(() => undefined);
      if (target?.isDirectory() === true) throw refuse();
    }
  }
  try {
    if (!isInside(await fs.realpath(existing), realRoot, platform)) throw refuse();
  } catch {
    throw refuse();
  }
}
