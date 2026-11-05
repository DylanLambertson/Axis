// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The changed-files list (design §3): two trees compared by `diff-tree -z`, parsed from NUL-separated records.
import { escapeForDisplay, escapeWithInfo, pathProblem, symlinkEscapes } from "./display.js";
import { invalid, unavailable } from "./errors.js";
import type { WorktreeRef } from "@axis/git-ops";
import { OBJECT_ID, expectComplete, expectOk, type ReviewGit } from "./gitcall.js";
import { attributesUntrusted } from "./attrtrust.js";
import { acquireIndex } from "./tempindex.js";
import type { ChangeKind, ChangeStatus, ProtectedPathMatcher, ReviewDeps, ReviewFile, ReviewLimits } from "./types.js";

export interface RawEntry {
  readonly oldMode: string;
  readonly newMode: string;
  readonly oldOid: string;
  readonly newOid: string;
  readonly status: ChangeStatus;
  readonly similarity?: number;
  readonly path: string;
  readonly oldPath?: string;
}

const META = /^:(\d{6}) (\d{6}) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-9a-f]{40}|[0-9a-f]{64}) ([A-Z])(\d{0,3})$/;
const NUMSTAT = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/;
const STATUSES = new Set<string>(["A", "M", "D", "R", "T"]);
export const REGULAR_MODES = new Set(["100644", "100755"]);

function malformed(): never {
  throw unavailable("git produced diff output that could not be read");
}

/**
 * Parses `diff-tree --raw -z --no-abbrev`. `overflow` is true when there are more than `maxFiles` entries (the rest are
 * not parsed). Anything that is not exactly the documented record shape is an error: nothing is guessed.
 */
export function parseRaw(out: string, maxFiles: number): { entries: RawEntry[]; overflow: boolean } {
  const tokens = out.split("\0");
  if (tokens[tokens.length - 1] === "") tokens.pop();
  const entries: RawEntry[] = [];
  for (let i = 0; i < tokens.length; ) {
    const m = META.exec(tokens[i] as string);
    if (!m || !STATUSES.has(m[5] as string)) return malformed();
    const status = m[5] as ChangeStatus;
    const rename = status === "R";
    const path = tokens[i + (rename ? 2 : 1)];
    const oldPath = rename ? tokens[i + 1] : undefined;
    if (path === undefined || (rename && oldPath === undefined)) return malformed();
    if (entries.length >= maxFiles) return { entries, overflow: true };
    entries.push({
      oldMode: m[1] as string,
      newMode: m[2] as string,
      oldOid: m[3] as string,
      newOid: m[4] as string,
      status,
      ...(rename ? { similarity: Number(m[6]) } : {}),
      path,
      ...(oldPath === undefined ? {} : { oldPath }),
    });
    i += rename ? 3 : 2;
  }
  return { entries, overflow: false };
}

export interface NumstatEntry {
  readonly additions: number | undefined;
  readonly deletions: number | undefined;
  readonly binary: boolean;
}

/** `diff-tree --numstat -z`, keyed by the (new) path. `-` counts mean git treats the file as binary. */
export function parseNumstat(out: string): Map<string, NumstatEntry> {
  const tokens = out.split("\0");
  if (tokens[tokens.length - 1] === "") tokens.pop();
  const map = new Map<string, NumstatEntry>();
  for (let i = 0; i < tokens.length; ) {
    const m = NUMSTAT.exec(tokens[i] as string);
    if (!m) return malformed();
    const rename = m[3] === "";
    const key = rename ? tokens[i + 2] : (m[3] as string);
    if (key === undefined) return malformed();
    const binary = m[1] === "-" || m[2] === "-";
    map.set(key, { additions: binary ? undefined : Number(m[1]), deletions: binary ? undefined : Number(m[2]), binary });
    i += rename ? 3 : 1;
  }
  return map;
}

const COMMON = ["-r", "-z", "--no-abbrev", "-M", "-l1000", "--no-ext-diff", "--no-textconv"] as const;

/** Object sizes by id, from one `cat-file --batch-check` call. */
async function objectSizes(git: ReviewGit, oids: readonly string[]): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  if (oids.length === 0) return sizes;
  const out = expectComplete(await git(["cat-file", "--batch-check=%(objectsize)"], { stdin: `${oids.join("\n")}\n` }), "read object sizes");
  const lines = out.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  if (lines.length !== oids.length) return malformed();
  lines.forEach((l, i) => {
    if (!/^\d{1,15}$/.test(l)) throw unavailable("an object of the diff is missing from the repository");
    sizes.set(oids[i] as string, Number(l));
  });
  return sizes;
}

/**
 * Paths that have a `filter` attribute, in the worktree's attribute files or the index's. No program runs: check-attr only
 * reads attribute files. Such a path is never offered (design §2): the snapshot ran with every filter off, so its bytes are
 * the smudged ones and "modified" may only mean "not cleaned", and a clean filter must not run inside the daemon.
 * (A filter literally named `unspecified` or `set` or `unset` cannot be told from no filter by check-attr; known limit.)
 */
export async function filteredPaths(git: ReviewGit, paths: readonly string[] | string[], baseIndex: string): Promise<Set<string>> {
  const found = new Set<string>();
  // A path that cannot be accepted anyway is not asked about (a `..` or absolute path would make check-attr refuse the batch).
  paths = paths.filter((p) => pathProblem(p) === undefined);
  if (paths.length === 0) return found;
  const stdin = `${paths.join("\0")}\0`;
  // Three reads, and a path is filtered if any names a driver: the worktree's attribute files, the real index's, and the base
  // tree's (a temporary index holding it). The base is where the stored blob came from: a CLI that stages an edit of
  // `.gitattributes`, removes it, or writes `-filter` into `.git/info/attributes` cannot make the stored blob look plain.
  // A path whose answer differs between them is therefore filtered too: nothing is offered on a changed answer.
  // Each read runs with core.ignorecase both ways: the setting changes which paths a pattern matches, and a `-filter` line can
  // match more paths one way than the other, so a path is filtered if either reading names a driver.
  const reads = [{ extra: [] as string[] }, { extra: ["--cached"] }, { extra: ["--cached"], index: baseIndex }] as const;
  for (const [read, ignorecase] of reads.flatMap((r) => [[r, "true"], [r, "false"]] as const)) {
    const out = expectComplete(
      await git(["check-attr", "-z", "--stdin", ...read.extra, "filter"], { stdin, config: [`core.ignorecase=${ignorecase}`], ..."index" in read ? { index: read.index } : {} }),
      "read the file attributes",
    );
    const t = out.split("\0");
    if (t[t.length - 1] === "") t.pop();
    if (t.length !== paths.length * 3) return malformed();
    for (let i = 0; i < t.length; i += 3) {
      const value = t[i + 2] as string;
      if (value !== "unspecified" && value !== "unset" && value !== "set") found.add(t[i] as string);
    }
  }
  return found;
}

function protectedRules(matcher: ProtectedPathMatcher | undefined, paths: readonly string[], maxDisplay: number): string[] {
  if (!matcher) return [];
  const rules = new Set<string>();
  for (const p of paths) {
    try {
      for (const hit of matcher.match(p)) rules.add(escapeForDisplay(String(hit.rule), { maxLength: Math.min(64, maxDisplay) }));
    } catch {
      // Fails closed: a matcher that cannot answer must not make a file look ordinary.
      rules.add("matcher-error");
    }
    if (rules.size >= 8) break;
  }
  return [...rules].slice(0, 8);
}

/** Lists what changed between two trees. Throws `too_large` when the list could not be complete. */
export async function listChanges(
  deps: ReviewDeps,
  w: WorktreeRef,
  git: ReviewGit,
  againstTree: string,
  worktreeTree: string,
  limits: ReviewLimits,
  matcher: ProtectedPathMatcher | undefined,
): Promise<ReviewFile[]> {
  if (!OBJECT_ID.test(againstTree) || !OBJECT_ID.test(worktreeTree)) throw invalid("both trees must be full object ids");
  const rawOut = expectComplete(await git(["diff-tree", ...COMMON, "--raw", againstTree, worktreeTree]), "list the changed files");
  const { entries, overflow } = parseRaw(rawOut, limits.maxFiles);
  if (overflow) throw invalid(`more than ${limits.maxFiles} files changed`, "too_large");
  const stats = parseNumstat(expectComplete(await git(["diff-tree", ...COMMON, "--numstat", againstTree, worktreeTree]), "count the changed lines"));

  const zero = /^0+$/;
  const wanted = new Set<string>();
  for (const e of entries) {
    for (const [mode, oid] of [[e.oldMode, e.oldOid], [e.newMode, e.newOid]] as const) {
      if (mode !== "160000" && mode !== "000000" && !zero.test(oid)) wanted.add(oid);
    }
  }
  const sizes = await objectSizes(git, [...wanted]);
  const allPaths = [...new Set(entries.flatMap((e) => (e.oldPath === undefined ? [e.path] : [e.path, e.oldPath])))];
  let filtered: Set<string>;
  let untrusted = false;
  if (allPaths.length === 0) filtered = new Set();
  else if ((untrusted = await attributesUntrusted(deps, git, w, limits))) filtered = new Set(allPaths);
  else {
    const idx = await acquireIndex(deps.tempIndex);
    try {
      expectOk(await git(["read-tree", againstTree], { index: idx.path }), "read the base tree");
      filtered = await filteredPaths(git, allPaths, idx.path);
    } finally {
      await idx.release();
    }
  }

  let linkReads = 0;
  const files: ReviewFile[] = [];
  for (const e of entries) {
    const warnings: string[] = [];
    const problem = pathProblem(e.path) ?? (e.oldPath === undefined ? undefined : pathProblem(e.oldPath));
    if (problem) warnings.push(`unsafe-path:${problem}`);
    const stat = stats.get(e.path);
    const linkSide = e.newMode === "120000" ? ([e.newOid, e.newMode] as const) : e.oldMode === "120000" ? ([e.oldOid, e.oldMode] as const) : undefined;
    const isSubmodule = e.newMode === "160000" || e.oldMode === "160000";
    const big = Math.max(sizes.get(e.oldOid) ?? 0, sizes.get(e.newOid) ?? 0) > limits.maxPreviewBytes;
    let kind: ChangeKind = "text";
    const isFiltered = filtered.has(e.path) || (e.oldPath !== undefined && filtered.has(e.oldPath));
    if (isFiltered) kind = "filtered";
    else if (isSubmodule) kind = "submodule";
    else if (linkSide) kind = "symlink";
    else if (stat?.binary === true) kind = "binary";
    else if (big) kind = "too-large";
    if (kind !== "text") warnings.push(kind);

    let link: ReviewFile["link"];
    if (kind === "symlink" && linkSide) {
      const oid = linkSide[0];
      const size = sizes.get(oid) ?? Infinity;
      let target: string | undefined;
      if (size <= 4096 && linkReads < limits.maxSymlinkReads) {
        linkReads++;
        const r = await git(["cat-file", "blob", oid]);
        if (r.code === 0 && r.truncated !== true) target = r.stdout;
      }
      // A link whose target could not be read is treated as escaping: it is never assumed harmless.
      const escapesWorktree = target === undefined ? true : symlinkEscapes(e.path, target);
      const shown = target === undefined ? undefined : escapeWithInfo(target, { maxLength: limits.maxDisplay });
      link = { target: shown?.text, escapesWorktree, targetCut: shown === undefined || shown.truncated };
      if (escapesWorktree && e.newMode === "120000") warnings.push("symlink-outside");
    }

    let reason: string | undefined;
    if (problem) reason = "unsafe_path";
    else if (isFiltered) reason = untrusted ? "attributes_untrusted" : "filtered_path";
    else if (e.status === "A" || e.status === "D" || e.status === "T") reason = e.status === "A" ? "added" : e.status === "D" ? "deleted" : "type_change";
    else if (kind !== "text") reason = kind;
    else if (e.oldOid === e.newOid) reason = "no_content_change";
    else if (!REGULAR_MODES.has(e.oldMode) || !REGULAR_MODES.has(e.newMode)) reason = "not_a_regular_file";

    const rules = protectedRules(matcher, e.oldPath === undefined ? [e.path] : [e.oldPath, e.path], limits.maxDisplay);
    files.push({
      path: e.path,
      ...(e.oldPath === undefined ? {} : { oldPath: e.oldPath }),
      status: e.status,
      kind,
      oldMode: e.oldMode,
      newMode: e.newMode,
      oldOid: e.oldOid,
      newOid: e.newOid,
      ...(e.similarity === undefined ? {} : { similarity: e.similarity }),
      ...(stat?.additions === undefined ? {} : { additions: stat.additions }),
      ...(stat?.deletions === undefined ? {} : { deletions: stat.deletions }),
      displayPath: escapeForDisplay(e.path, { maxLength: limits.maxDisplay, cut: "middle" }),
      ...(e.oldPath === undefined ? {} : { displayOldPath: escapeForDisplay(e.oldPath, { maxLength: limits.maxDisplay, cut: "middle" }) }),
      unsafePath: problem !== undefined,
      protectedRules: rules,
      ...(reason === undefined ? {} : { fileLevelReason: reason }),
      ...(link === undefined ? {} : { link }),
      warnings,
    });
  }
  return files;
}
