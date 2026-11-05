// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// WT-3: paths whose content runs later (CI, tasks, hooks) and Git directories (WT-2, hook persistence).

export interface ProtectedMatch {
  /** A Git directory path (`.git` at any depth): also gated for reads, since `.git/config` can hold credentials. */
  readonly gitDir: boolean;
  readonly label: string;
}

/** Root-anchored protected paths, each a list of folded segments. A prefix match covers everything below. */
export const DEFAULT_PROTECTED: readonly (readonly string[])[] = [
  // The whole of `.github`: a local composite action under `.github/actions` runs in CI like a workflow does.
  [".github"],
  [".vscode"],
  [".husky"],
  [".githooks"],
  ["lefthook.yml"],
  ["lefthook.yaml"],
  [".lefthook.yml"],
  [".pre-commit-config.yaml"],
  [".devcontainer"],
  [".devcontainer.json"],
  [".gitmodules"],
];

/** File-name suffixes protected at any depth: a `.code-workspace` file carries `tasks` and `settings` like `.vscode/`. */
export const PROTECTED_SUFFIXES: readonly string[] = [".code-workspace"];

/**
 * Names that take effect from any directory (WT-3: `package.json` scripts, `.npmrc`, `.envrc`, `Makefile`), so a
 * file called this anywhere below the root is protected. `.gitattributes` is read from every directory by git.
 */
export const PROTECTED_ANYWHERE: readonly string[] = [
  "package.json", ".npmrc", ".envrc", ".gitattributes", "makefile", "gnumakefile", "justfile", ".yarnrc", ".yarnrc.yml", ".pnpmfile.cjs",
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

function sameName(folded: string, protectedName: string, shortNames: boolean): boolean {
  if (folded === protectedName) return true;
  if (!shortNames) return false;
  const prefix = shortNamePrefix(folded);
  if (prefix === undefined) return false;
  const bare = protectedName.replace(/^\./, "").slice(0, 6);
  return bare.length > 0 && bare.startsWith(prefix.replace(/^\./, ""));
}

/**
 * Whether `segments` (relative to the worktree root) name a protected path. Call it with the lexical segments and
 * with the real-path segments; either may match. `extra` adds root-anchored entries.
 */
export function matchProtected(segments: readonly string[], extra: readonly (readonly string[])[] = [], platform?: NodeJS.Platform): ProtectedMatch | undefined {
  const folded = segments.map(foldSegment);
  // 8.3 short names exist on Windows only; with no platform given the check stays on, which can only ask more.
  const short = platform === undefined || platform === "win32";
  if (folded.some((s) => sameName(s, ".git", short))) return { gitDir: true, label: ".git" };
  const last = folded[folded.length - 1];
  if (last !== undefined) {
    // A file name anywhere below the root; a directory that merely has the name (`docs/makefile/readme.md`) is not it.
    for (const name of PROTECTED_ANYWHERE) if (sameName(last, name, short)) return { gitDir: false, label: name };
    for (const suffix of PROTECTED_SUFFIXES) if (last.endsWith(suffix) && last !== suffix) return { gitDir: false, label: `*${suffix}` };
  }
  for (const entry of [...DEFAULT_PROTECTED, ...extra]) {
    if (entry.length > folded.length) continue;
    if (entry.every((name, i) => sameName(folded[i] as string, foldSegment(name), short))) return { gitDir: false, label: entry.join("/") };
  }
  return undefined;
}
