// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Helpers for the post-commit index refresh tests (DC-0 slice 2): commits made with plumbing in a private index, so the real
// index stays exactly as each test set it up, and readers of the real index that never write it.
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Fixture } from "./realFixture.js";

export type Change = string | null | { readonly mode: string; readonly oid?: string; readonly text?: string };

/**
 * A commit on top of HEAD with `changes` (path to new text, `null` to delete, or a mode with text or an object id), made in a
 * private index and moved onto the branch by compare-and-swap, as an Axis commit is. Returns the old and the new HEAD.
 */
export function commitOnTop(f: Fixture, changes: Readonly<Record<string, Change>>, branch = "axis/feat"): { old: string; next: string } {
  const old = f.git("rev-parse", "HEAD").trim();
  const idx = join(f.root, `private-index-${Math.random().toString(36).slice(2)}`);
  const run = (args: string[], input?: string): string =>
    execFileSync("git", args, { cwd: f.wt.workTree, env: { ...f.env, GIT_INDEX_FILE: idx }, encoding: "utf8", ...(input === undefined ? {} : { input }) });
  run(["read-tree", "HEAD"]);
  for (const [path, c] of Object.entries(changes)) {
    if (c === null) {
      run(["update-index", "--force-remove", "--", path]);
      continue;
    }
    const mode = typeof c === "string" ? "100644" : c.mode;
    const oid = typeof c === "string" ? run(["hash-object", "-w", "--stdin"], c).trim() : c.oid ?? run(["hash-object", "-w", "--stdin"], c.text ?? "").trim();
    run(["update-index", "--add", "--cacheinfo", `${mode},${oid},${path}`]);
  }
  const tree = run(["write-tree"]).trim();
  const next = run(["commit-tree", tree, "-p", old, "-m", "on top"]).trim();
  run(["update-ref", `refs/heads/${branch}`, next, old]);
  return { old, next };
}

export const indexPath = (f: Fixture): string => join(f.wt.gitDir, "index");
export const indexBytes = (f: Fixture): Buffer => readFileSync(indexPath(f));
export const indexMode = (f: Fixture): number => statSync(indexPath(f)).mode & 0o7777;

/** The real index's stage-0 entries as `mode oid path`, read without writing it (`ls-files` never refreshes). */
export function entries(f: Fixture): Map<string, string> {
  const out = f.git("ls-files", "--stage", "-z");
  const m = new Map<string, string>();
  for (const rec of out.split("\0").filter((r) => r !== "")) {
    const [meta, path] = rec.split("\t") as [string, string];
    const [mode, oid] = meta.split(" ");
    m.set(path, `${mode} ${oid}`);
  }
  return m;
}

/** HEAD's tree entries in the same shape. */
export function headEntries(f: Fixture, rev = "HEAD"): Map<string, string> {
  const m = new Map<string, string>();
  for (const rec of f.git("ls-tree", "-r", "-z", rev).split("\0").filter((r) => r !== "")) {
    const [meta, path] = rec.split("\t") as [string, string];
    const [mode, , oid] = meta.split(" ");
    m.set(path, `${mode} ${oid}`);
  }
  return m;
}

/** One entry's `ls-files --stage --debug` record (its stat data and flags), to show an entry was kept byte for byte. */
export function debugOf(f: Fixture, path: string): string {
  return f.git("ls-files", "--stage", "--debug", "--", path);
}
