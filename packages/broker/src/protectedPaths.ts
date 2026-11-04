// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// WT-3: paths whose content runs later (CI, tasks, hooks) and Git directories (WT-2, hook persistence).

export interface ProtectedMatch {
  /** A Git directory path (`.git` at any depth): also gated for reads, since `.git/config` can hold credentials. */
  readonly gitDir: boolean;
  readonly label: string;
}

/** Root-anchored protected paths, each a list of folded segments. A prefix match covers everything below. */
export const DEFAULT_PROTECTED: readonly (readonly string[])[] = [
  [".github", "workflows"],
  [".vscode"],
  [".husky"],
  [".githooks"],
  ["lefthook.yml"],
  ["lefthook.yaml"],
  [".lefthook.yml"],
  [".pre-commit-config.yaml"],
  [".devcontainer"],
  [".npmrc"],
  [".envrc"],
  [".gitmodules"],
  [".gitattributes"],
];

const IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu;

/**
 * One path segment in the form used for matching, on every platform: Unicode compatibility-normalised, default
 * ignorable code points removed (HFS+ ignores them), lower case, trailing dots and spaces removed (NTFS). Matching
 * in this folded form over-matches on a case-sensitive file system, which only means an extra approval.
 */
export function foldSegment(seg: string): string {
  const f = seg.normalize("NFKC").replace(IGNORABLE, "").toLowerCase().normalize("NFKC");
  const trimmed = f.replace(/[. ]+$/, "");
  return trimmed === "" ? f : trimmed;
}

/** `GITHUB~1` style names: the folded prefix before `~N` of a candidate alias, or undefined. */
function shortNamePrefix(folded: string): string | undefined {
  const m = /^([^~]{1,6})~\d+(?:\.[^.]*)?$/.exec(folded);
  return m === null ? undefined : (m[1] as string);
}

function sameName(folded: string, protectedName: string): boolean {
  if (folded === protectedName) return true;
  const prefix = shortNamePrefix(folded);
  if (prefix === undefined) return false;
  const bare = protectedName.replace(/^\./, "").slice(0, 6);
  return bare.length > 0 && bare.startsWith(prefix.replace(/^\./, ""));
}

/**
 * Whether `segments` (relative to the worktree root) name a protected path. Call it with the lexical segments and
 * with the real-path segments; either may match. `extra` adds root-anchored entries.
 */
export function matchProtected(segments: readonly string[], extra: readonly (readonly string[])[] = []): ProtectedMatch | undefined {
  const folded = segments.map(foldSegment);
  if (folded.some((s) => sameName(s, ".git"))) return { gitDir: true, label: ".git" };
  for (const entry of [...DEFAULT_PROTECTED, ...extra]) {
    if (entry.length > folded.length) continue;
    if (entry.every((name, i) => sameName(folded[i] as string, foldSegment(name)))) return { gitDir: false, label: entry.join("/") };
  }
  return undefined;
}
