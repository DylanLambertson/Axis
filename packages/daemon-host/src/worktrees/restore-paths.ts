// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { worktreeFailure } from "./errors.js";
import { isInside } from "./locator.js";

/**
 * A repository-relative path of a restore request, checked against the disk before anything is written (DMN-2). The
 * contract schema already refuses absolute, drive, `..`, empty, backslash, `.git` and control-character paths; this is the
 * layer that the schema cannot be: a symlink a CLI run planted inside the workspace. Every component under the workspace
 * root is `lstat`ed and none may be a symlink (a link to another workspace, to the outside, to the `.git` directory, or a
 * dangling one), a parent must be a directory, and the deepest existing parent must still resolve inside the real
 * workspace root. A component that does not exist ends the walk (the manager creates missing folders with its own checks).
 * Every refusal is the same closed `E_INVALID_ARGUMENT` (`unsafe_path`): nothing about the layout is revealed.
 * Residual: a swap between this check and the write is closed by the manager's own `expectedWorktree` check, which
 * refuses a write that resolves into another worktree.
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
    if (st.isSymbolicLink()) throw refuse();
    if (i < parts.length - 1) {
      if (!st.isDirectory()) throw refuse();
      existing = cur;
    }
  }
  try {
    if (!isInside(await fs.realpath(existing), realRoot, platform)) throw refuse();
  } catch {
    throw refuse();
  }
}
