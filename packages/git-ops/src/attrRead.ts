// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// REV2-FIX (REV-2, G-27): attribute reads that no later write to the repository's attribute sources can change.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkWorktree, daemonGitFor, type DaemonGit } from "./args.js";
import { GitOpsError, denied } from "./errors.js";
import type { GitOpsDeps, WorktreeRef } from "./types.js";

/** Largest attribute source snapshotted; a larger one is refused rather than cut (a cut file reads as a different rule set). */
export const MAX_ATTRIBUTE_FILE = 1024 * 1024;

export interface AttributeReadOptions {
  /** Absolute path of the user-level attribute file to take a snapshot of (`core.attributesFile`). Default: none, so user attributes are not read. */
  readonly userAttributesFile?: string;
  /** Absolute path of the index to read tracked attributes from; only `GIT_INDEX_FILE` reaches git. */
  readonly indexFile?: string;
}

export interface AttributeRead {
  /** Daemon-hardened git over a private empty git directory: nothing in the real git directory (config, `info/attributes`) is read. */
  readonly git: DaemonGit;
  /** The text of `info/attributes` taken ONCE; it is what `git` sees, so the caller can refuse any line in it. */
  readonly infoAttributes: string;
  /** Removes the private directory. Call it in a `finally`. */
  dispose(): void;
}

/** One bounded read; a missing file is "", anything else that is not a plain file within the limit is a refusal. */
function readOnce(path: string): string {
  let size: number;
  try {
    const st = statSync(path);
    if (!st.isFile()) throw denied("an attribute source is not a regular file");
    size = st.size;
  } catch (e) {
    if (e instanceof GitOpsError) throw e;
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw new GitOpsError("E_UNAVAILABLE", "could not read an attribute source");
  }
  if (size > MAX_ATTRIBUTE_FILE) throw denied("an attribute source is too large to snapshot");
  const text = readFileSync(path, "utf8");
  if (text.length > MAX_ATTRIBUTE_FILE) throw denied("an attribute source is too large to snapshot");
  return text;
}

/** Where `info/` and `objects/` live: the git directory, or its `commondir` for a linked worktree. */
function commonDirOf(gitDir: string): string {
  const link = readOnce(join(gitDir, "commondir")).split("\n")[0]?.trim() ?? "";
  return link === "" ? gitDir : resolve(gitDir, link);
}

/**
 * A daemon git whose repository is a private, empty git directory: the objects come from the real store through an
 * alternates file, `info/attributes` and the user attribute file are copies taken once (so a write to the real ones
 * after this call changes nothing git reads), `GIT_ATTR_NOSYSTEM=1` drops the system file, and the repository config is
 * not read (core.attributesFile, filters and drivers defined there do not apply; the user's global config filters are
 * still neutralised as for every daemon call). The work tree's tracked attribute files are read as before.
 */
export async function attributeReadGit(w: WorktreeRef, deps: GitOpsDeps, opts: AttributeReadOptions = {}): Promise<AttributeRead> {
  checkWorktree(w, deps.platform ?? process.platform);
  const common = commonDirOf(w.gitDir);
  const objects = join(common, "objects");
  // alternates is one path per line: a name with a line break or a leading '#' would be read as something else.
  if (/[\r\n]/.test(objects) || objects.startsWith("#")) throw denied("the object directory cannot be named in an alternates file");
  const infoAttributes = readOnce(join(common, "info", "attributes"));
  const userAttributes = opts.userAttributesFile === undefined ? "" : readOnce(opts.userAttributesFile);
  const dir = mkdtempSync(join(tmpdir(), "axis-attr-"));
  const dispose = (): void => rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  try {
    for (const d of ["objects/info", "refs", "info"]) mkdirSync(join(dir, d), { recursive: true });
    writeFileSync(join(dir, "HEAD"), "ref: refs/heads/axis-attributes\n");
    writeFileSync(join(dir, "objects", "info", "alternates"), `${objects}\n`);
    writeFileSync(join(dir, "info", "attributes"), infoAttributes);
    const userFile = join(dir, "user-attributes");
    writeFileSync(userFile, userAttributes);
    const git = await daemonGitFor({ workTree: w.workTree, gitDir: dir }, deps, opts.indexFile === undefined ? {} : { GIT_INDEX_FILE: opts.indexFile }, {
      config: [`core.attributesFile=${userFile}`],
      env: { GIT_ATTR_NOSYSTEM: "1" },
    });
    return { git, infoAttributes, dispose };
  } catch (e) {
    dispose();
    throw e;
  }
}
