// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// REV2-FIX (REV-2, G-27): attribute reads that no later write to the repository's attribute sources can change.
import { closeSync, constants, fstatSync, mkdirSync, mkdtempSync, openSync, readSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute as posixAbs, join, resolve } from "node:path/posix";
import { isAbsolute as winAbs } from "node:path/win32";
import { checkWorktree, daemonGitFor, type DaemonGit } from "./args.js";
import { GitOpsError, denied, invalid } from "./errors.js";
import type { GitOpsDeps, WorktreeRef } from "./types.js";

/** Largest attribute source snapshotted; a larger one is refused rather than cut (a cut file reads as a different rule set). */
export const MAX_ATTRIBUTE_FILE = 1024 * 1024;

export interface AttributeReadOptions {
  /** Absolute path of the user-level attribute file to take a snapshot of (`core.attributesFile`). Default: none, so user attributes are not read. */
  readonly userAttributesFile?: string;
  /**
   * Absolute path of the system attribute file to take a snapshot of (what `git var GIT_ATTR_SYSTEM` names). Default: none.
   * Its bytes are placed BEFORE the user file's in the one private `core.attributesFile`, which keeps git's order (system
   * below user below every tracked file) while `GIT_ATTR_NOSYSTEM=1` stops git reading the real one.
   */
  readonly systemAttributesFile?: string;
  /** Absolute path of the index to read tracked attributes from; only `GIT_INDEX_FILE` reaches git. */
  readonly indexFile?: string;
  /** The real repository's object format (default `sha1`): the private directory must use the same one to read its objects and indexes. */
  readonly objectFormat?: "sha1" | "sha256";
}

export interface AttributeRead {
  /** Daemon-hardened git over a private empty git directory: nothing in the real git directory (config, `info/attributes`) is read. */
  readonly git: DaemonGit;
  /** `info/attributes` taken ONCE, as a UTF-8 view for display and for refusing any line in it. Invalid UTF-8 shows as U+FFFD here; git reads the exact bytes (`infoAttributesBytes`). */
  readonly infoAttributes: string;
  /** The exact bytes of `info/attributes` that `git` reads. */
  readonly infoAttributesBytes: Uint8Array;
  /** The exact bytes git reads as `core.attributesFile`: the system snapshot, a line break when it lacks one, then the user snapshot. */
  readonly outsideAttributesBytes: Uint8Array;
  /** A UTF-8 view of `outsideAttributesBytes` (invalid UTF-8 shows as U+FFFD), so a caller can refuse a macro defined there. */
  readonly outsideAttributes: string;
  /**
   * Another caller over the SAME private directory and snapshots, reading tracked attributes from `indexFile` (absolute) with
   * `check-attr --cached`, so one snapshot serves reads of several trees. Valid until `dispose()`.
   */
  withIndex(indexFile: string): Promise<DaemonGit>;
  /** Removes the private directory. Call it in a `finally`. */
  dispose(): void;
}

/** One bounded read of the bytes through ONE open file (no stat-then-read gap); a missing file is empty, anything else that is not a plain file within the limit is a refusal. */
function readOnce(path: string): Buffer {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return Buffer.alloc(0);
    throw new GitOpsError("E_UNAVAILABLE", "could not read an attribute source");
  }
  try {
    if (!fstatSync(fd).isFile()) throw denied("an attribute source is not a regular file");
    const buf = Buffer.alloc(MAX_ATTRIBUTE_FILE + 1);
    let n = 0;
    for (let r = 1; r > 0 && n < buf.length; n += r) r = readSync(fd, buf, n, buf.length - n, null);
    if (n > MAX_ATTRIBUTE_FILE) throw denied("an attribute source is too large to snapshot");
    return buf.subarray(0, n);
  } catch (e) {
    if (e instanceof GitOpsError) throw e;
    throw new GitOpsError("E_UNAVAILABLE", "could not read an attribute source");
  } finally {
    closeSync(fd);
  }
}

/** Where `info/` and `objects/` live: the git directory, or its `commondir` for a linked worktree. */
function commonDirOf(gitDir: string): string {
  const link = readOnce(join(gitDir, "commondir")).toString("utf8").split("\n")[0]?.trim() ?? "";
  return link === "" ? gitDir : resolve(gitDir, link);
}

/**
 * A daemon git whose repository is a private, empty git directory: the objects come from the real store through an
 * alternates file, `info/attributes` and the user attribute file are copies taken once (so a write to the real ones
 * after this call changes nothing git reads), `GIT_ATTR_NOSYSTEM=1` drops the system file, and the repository config is
 * not read (core.attributesFile, filters and drivers defined there do not apply; the user's global config filters are
 * still neutralised as for every daemon call). The work tree's tracked attribute files are read as before.
 *
 * LIMITS: (1) the tracked `.gitattributes` files are read from the work tree unless the caller passes `--cached` with an index it
 * built from a tree object (`withIndex`, as `@axis/review` does); only `info/attributes`, the user file and the system file are
 * snapshotted here. (2) The system git config is still read. (3) The user's global config is not found (HOME is private), and
 * the repository config is not read.
 */
export async function attributeReadGit(w: WorktreeRef, deps: GitOpsDeps, opts: AttributeReadOptions = {}): Promise<AttributeRead> {
  checkWorktree(w, deps.platform ?? process.platform);
  const common = commonDirOf(w.gitDir);
  const objects = join(common, "objects");
  // alternates is one path per line: a name with a line break would be read as two entries (an absolute path cannot start with '#').
  if (/[\r\n]/.test(objects)) throw denied("the object directory cannot be named in an alternates file");
  const platform = deps.platform ?? process.platform;
  if (opts.objectFormat !== undefined && opts.objectFormat !== "sha1" && opts.objectFormat !== "sha256") throw invalid("the object format must be sha1 or sha256");
  for (const [what, file] of [["user", opts.userAttributesFile], ["system", opts.systemAttributesFile]] as const) {
    if (file !== undefined && (file.includes("\0") || !(platform === "win32" ? winAbs : posixAbs)(file))) throw invalid(`the ${what} attributes file must be an absolute path`);
  }
  const infoAttributes = readOnce(join(common, "info", "attributes"));
  const system = opts.systemAttributesFile === undefined ? Buffer.alloc(0) : readOnce(opts.systemAttributesFile);
  const user = opts.userAttributesFile === undefined ? Buffer.alloc(0) : readOnce(opts.userAttributesFile);
  // A system file whose last line has no line break would otherwise run into the user file's first line.
  const joint = system.length > 0 && system[system.length - 1] !== 0x0a ? Buffer.from("\n") : Buffer.alloc(0);
  const outside = Buffer.concat([system, joint, user]);
  const dir = mkdtempSync(join(tmpdir(), "axis-attr-"));
  const dispose = (): void => rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  try {
    for (const d of ["objects/info", "refs", "info"]) mkdirSync(join(dir, d), { recursive: true });
    writeFileSync(join(dir, "HEAD"), "ref: refs/heads/axis-attributes\n");
    // Axis-written, never the real repository's config: only what a SHA-256 store needs to be read.
    if (opts.objectFormat === "sha256") writeFileSync(join(dir, "config"), "[core]\n\trepositoryformatversion = 1\n[extensions]\n\tobjectFormat = sha256\n");
    writeFileSync(join(dir, "objects", "info", "alternates"), `${objects}\n`);
    writeFileSync(join(dir, "info", "attributes"), infoAttributes);
    const userFile = join(dir, "user-attributes");
    writeFileSync(userFile, outside);
    // HOME and the XDG/profile variables point at an empty directory, so the user's global config (diff.external, diff.<x>.textconv,
    // filters) is not found. GIT_CONFIG_* cannot be used (the runner refuses them), so the system config is still read: callers pass
    // --no-ext-diff and --no-textconv on any diff.
    const home = join(dir, "home");
    mkdirSync(home);
    const fixed = {
      config: [`core.attributesFile=${userFile}`],
      env: { GIT_ATTR_NOSYSTEM: "1", HOME: home, XDG_CONFIG_HOME: home, ...(platform === "win32" ? { USERPROFILE: home } : {}) },
    };
    const at = (indexFile: string | undefined): Promise<DaemonGit> =>
      daemonGitFor({ workTree: w.workTree, gitDir: dir }, deps, indexFile === undefined ? {} : { GIT_INDEX_FILE: indexFile }, fixed);
    const git = await at(opts.indexFile);
    return {
      git,
      infoAttributes: infoAttributes.toString("utf8"),
      infoAttributesBytes: new Uint8Array(infoAttributes),
      outsideAttributes: outside.toString("utf8"),
      outsideAttributesBytes: new Uint8Array(outside),
      withIndex: (indexFile) => at(indexFile),
      dispose,
    };
  } catch (e) {
    dispose();
    throw e;
  }
}
