// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { lstat, readlink } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative } from "node:path";
import { realish } from "./paths.js";

export type ProtectedCategory =
  | "ci"
  | "editor-config"
  | "dev-container"
  | "git-hooks"
  | "container-build"
  | "package-scripts"
  | "package-config"
  | "shell-env"
  | "build-script"
  | "hidden-config"
  | "instruction-file"
  | "ignore-rules"
  | "caller-defined"
  | "git-dir"
  | "git-config"
  | "outside-worktree"
  | "invalid-path";

export interface ProtectedMatch {
  readonly category: ProtectedCategory;
  readonly severity: "high" | "medium";
  /** Which rule matched (a stable name for the highlight tooltip). */
  readonly rule: string;
  /** `symlink` when the path only reaches a protected location through a link. */
  readonly via: "path" | "symlink";
  /** The root-relative location the path resolves to, when it differs from what was asked. */
  readonly resolved?: string;
}

interface Rule {
  readonly rule: string;
  readonly category: ProtectedCategory;
  readonly severity: "high" | "medium";
  /** Anchored at the worktree root, or at any depth. */
  readonly anywhere: boolean;
  /** A directory prefix or file name, as folded components. */
  readonly path?: readonly string[];
  /** For families of names (Dockerfile.*), a test on one folded component. */
  readonly test?: (comp: string) => boolean;
}

const dir = (rule: string, category: ProtectedCategory, severity: "high" | "medium", anywhere: boolean, ...path: string[]): Rule => ({
  rule,
  category,
  severity,
  anywhere,
  path,
});
const names = (category: ProtectedCategory, severity: "high" | "medium", ...files: string[]): Rule[] =>
  files.map((f) => dir(f, category, severity, true, f));
const fam = (rule: string, category: ProtectedCategory, test: (c: string) => boolean): Rule => ({
  rule,
  category,
  severity: "high",
  anywhere: true,
  test,
});

// WT-3 plus gap G-3: files that run later, for the user or in CI, and the Git directory itself.
const RULES: readonly Rule[] = [
  dir(".github/workflows", "ci", "high", false, ".github", "workflows"),
  dir(".github/actions", "ci", "high", false, ".github", "actions"),
  dir(".circleci", "ci", "high", false, ".circleci"),
  dir(".buildkite", "ci", "high", false, ".buildkite"),
  dir(".azure-pipelines", "ci", "high", false, ".azure-pipelines"),
  dir(".gitlab", "ci", "high", false, ".gitlab"),
  ...names("ci", "high", ".gitlab-ci.yml", "azure-pipelines.yml", "jenkinsfile", ".travis.yml", "bitbucket-pipelines.yml", ".drone.yml", "appveyor.yml", ".appveyor.yml", "cloudbuild.yaml", "cloudbuild.yml", "buildkite.yml", "buildkite.yaml"),
  dir(".vscode", "editor-config", "high", true, ".vscode"),
  dir(".devcontainer", "dev-container", "high", true, ".devcontainer"),
  ...names("dev-container", "high", ".devcontainer.json"),
  dir(".husky", "git-hooks", "high", true, ".husky"),
  dir(".githooks", "git-hooks", "high", true, ".githooks"),
  ...names("git-hooks", "high", "lefthook.yml", "lefthook.yaml", ".lefthook.yml", ".lefthook.yaml", "lefthook-local.yml", "lefthook-local.yaml", ".lefthook-local.yml", ".lefthook-local.yaml", ".pre-commit-config.yaml", ".pre-commit-hooks.yaml"),
  fam("Dockerfile", "container-build", (c) => c === "dockerfile" || c.startsWith("dockerfile.") || c.endsWith(".dockerfile")),
  fam("Containerfile", "container-build", (c) => c === "containerfile" || c.startsWith("containerfile.") || c.endsWith(".containerfile")),
  fam("compose file", "container-build", (c) => /^(?:docker-compose|compose)(?:[.-][a-z0-9._-]*)?\.ya?ml$/.test(c)),
  ...names("package-scripts", "medium", "package.json"),
  ...names("package-config", "high", ".npmrc", ".yarnrc", ".yarnrc.yml", ".pnpmfile.cjs", ".pypirc", "pip.conf", ".bunfig.toml", "bunfig.toml"),
  dir(".cargo/config", "package-config", "high", true, ".cargo"),
  ...names("shell-env", "high", ".envrc", ".mise.toml", "mise.toml"),
  dir(".yarn/plugins", "package-config", "high", false, ".yarn", "plugins"),
  ...names("build-script", "medium", "conftest.py", "build.rs", "pyproject.toml", "makefile", "gnumakefile", "justfile", "taskfile.yml", "taskfile.yaml", "rakefile", "build.gradle", "build.gradle.kts", "setup.py", "noxfile.py"),
  fam(".env family", "shell-env", (c) => c === ".env" || c.startsWith(".env.")),
  dir(".git", "git-dir", "high", true, ".git"),
  ...names("git-config", "high", ".gitmodules", ".gitattributes"),
];

// Code points HFS+ and APFS-style comparison ignores in a name (CVE-2014-9390 class): `.g<ZWNJ>it` is `.git`.
const IGNORABLE = /[\u200b-\u200f\u202a-\u202e\u206a-\u206f\ufeff\u00ad\u2060\u180e]/g;
const MARKS = /\p{M}/gu;
// Letters that look like an ASCII one and do not fold to it by case or normalisation (latin small script g).
const LOOKALIKES = new RegExp(String.fromCharCode(0x261), "g");
const MAX_PATH = 4096;
const MAX_PARTS = 256;

/** The comparison form of one path component. */
export function foldName(comp: string): string {
  // Upper then lower: the dotless i and the long s fold to the plain letter, as an NTFS upcase table does.
  return comp
    .replace(IGNORABLE, "")
    .normalize("NFKC")
    .normalize("NFD")
    .replace(MARKS, "")
    .toUpperCase()
    .toLowerCase()
    .replace(LOOKALIKES, "g");
}

// NTFS: a trailing dot or space is dropped, `name:stream` is the same file, and `GITHUB~1` is `.github`.
function ntfsClean(comp: string): string {
  const colon = comp.indexOf(":");
  const base = colon >= 0 ? comp.slice(0, colon) : comp;
  return base.replace(/[ .]+$/, "");
}

function shortMatches(comp: string, literal: string): boolean {
  const m = /^([^~.]{1,6})~\d{1,7}(?:\.(.{0,3}))?$/.exec(comp);
  if (m === null) return false;
  const dot = literal.lastIndexOf(".");
  const hasExt = dot > 0;
  // Windows keeps these characters in the generated name (so PRE-CO~1.YAM for .pre-commit-config.yaml) and drops dots and spaces.
  const base = (hasExt ? literal.slice(0, dot) : literal).replace(/[^a-z0-9_$%'@!#()&^{}-]/g, "");
  const ext = hasExt ? literal.slice(dot + 1) : "";
  return base.slice(0, 6) === m[1] && (m[2] === undefined || m[2] === "" || ext.startsWith(m[2]));
}

const compEquals = (comp: string, literal: string): boolean => comp === literal || shortMatches(comp, literal);

/** `parts` are folded for comparison; `raws` keep their spelling (after normalisation and NTFS clean-up) for the one rule that reads case. */
type Parts = { readonly parts: string[]; readonly raws: string[]; readonly escapes: boolean } | null;

/** Splits on `/` and `\`, applies `.` and `..`, drops empty parts, folds each name. Null when the path is not usable. */
function split(rel: string): Parts {
  if (rel.length > MAX_PATH || rel.includes("\0")) return null;
  const stack: string[] = [];
  const raws: string[] = [];
  let escapes = false;
  const raw = rel.replace(IGNORABLE, "").normalize("NFKC").split(/[\\/]+/);
  if (raw.length > MAX_PARTS) return null;
  for (const piece of raw) {
    if (piece === "" || piece === ".") continue;
    if (piece === "..") {
      raws.pop();
      if (stack.pop() === undefined) escapes = true;
      continue;
    }
    const clean = ntfsClean(piece);
    if (clean === "") continue;
    stack.push(foldName(clean));
    raws.push(clean);
  }
  return { parts: stack, raws, escapes };
}

function matchRule(parts: readonly string[], r: Rule): boolean {
  if (r.test !== undefined) return parts.some((p) => r.test?.(p) === true);
  const path = r.path as readonly string[];
  const last = parts.length - path.length;
  for (let start = 0; start <= (r.anywhere ? last : Math.min(last, 0)); start++) {
    if (path.every((lit, i) => compEquals(parts[start + i] as string, foldLiteral(lit)))) return true;
  }
  return false;
}

const foldCache = new Map<string, string>();
const foldLiteral = (lit: string): string => {
  let v = foldCache.get(lit);
  if (v === undefined) foldCache.set(lit, (v = foldName(lit)));
  return v;
};

export interface MatchOptions {
  /**
   * Root-relative paths the caller also wants highlighted (for example a directory of tool configuration that
   * belongs to a product setting, not to this list). Matched as folded prefixes, with the same rules.
   */
  readonly extraPaths?: readonly string[];
}

function matchExtra(parts: readonly string[], extra: readonly string[] | undefined): ProtectedMatch | null {
  for (const x of extra ?? []) {
    const sp = split(x);
    if (sp === null || sp.escapes || sp.parts.length === 0) continue;
    if (sp.parts.length <= parts.length && sp.parts.every((p, i) => compEquals(parts[i] as string, p))) {
      return { category: "caller-defined", severity: "high", rule: "caller-defined path", via: "path" };
    }
  }
  return null;
}

// Generic rules for what no list can name: configuration other programs read from a checkout. They are judged after
// the specific rules above, so those keep their own categories, and they apply at any depth. No product is named
// here: the host adds the names it knows about through `extraPaths`, from the user's own settings, never from the
// repository.
//
// Ignore and style files are not exempt, only less severe: a run that adds a new config file and an ignore rule for
// it must still show a change. An exemption covers the exact final name, never a directory of that name.
const IGNORE_FILES = new Set([".gitignore", ".dockerignore", ".prettierignore", ".eslintignore"]);
const STYLE_FILES = new Set([".editorconfig"]);
const COMMON_DOCS = new Set([
  "readme", "license", "licence", "copying", "copyright", "notice", "changelog", "changes", "history", "news", "contributing",
  "contributors", "security", "code_of_conduct", "authors", "maintainers", "codeowners", "support", "governance", "todo",
  "release", "releases", "roadmap", "install", "upgrading", "citation", "credits", "thanks", "patents", "acknowledgements",
]);
// A generated short name (`ALPHA~1`, `PLAYBO~1.MD`) may stand for a dot name or a long name: it cannot be ruled out.
const SHORT_NAME = /^[^~.]{1,6}~\d{1,7}(?:\.[^.]{0,3})?$/;
// An upper-case first segment, any further segments, and `.md`: `NAME.md`, `NAME.local.md`, `NAME.override.md`.
const UPPER_MD = /^([A-Z0-9_-]*[A-Z][A-Z0-9_-]*)(?:\.[A-Za-z0-9_-]+)*\.[mM][dD]$/;

const generic = (category: ProtectedCategory, severity: "high" | "medium", rule: string): ProtectedMatch => ({ category, severity, rule, via: "path" });

function matchGeneric(parts: readonly string[], raws: readonly string[]): ProtectedMatch | null {
  const lastIdx = parts.length - 1;
  for (let i = 0; i <= lastIdx; i++) {
    const c = parts[i] as string;
    if (c.startsWith(".") && c !== "." && c !== "..") {
      const exact = i === lastIdx;
      if (exact && IGNORE_FILES.has(c)) return generic("ignore-rules", "medium", "ignore rules (reviewable)");
      if (exact && STYLE_FILES.has(c)) return generic("hidden-config", "medium", "style file (reviewable)");
      return generic("hidden-config", "high", "dot name");
    }
    if (SHORT_NAME.test(c)) return generic("hidden-config", "high", "short name");
  }
  const last = raws[lastIdx];
  if (last === undefined) return null;
  // At the root any plain `.md` name counts, in any case: it is the same file on a case-insensitive volume.
  if (lastIdx === 0 && /^[a-z0-9_-]+\.md$/.test(parts[0] as string) && !COMMON_DOCS.has((parts[0] as string).slice(0, -3))) {
    return generic("instruction-file", "high", "root-level .md file");
  }
  // Below the root only the upper-case spelling counts, so ordinary lower-case documents stay unmarked.
  const m = UPPER_MD.exec(last);
  if (m !== null && !COMMON_DOCS.has((m[1] as string).toLowerCase())) return generic("instruction-file", "high", "upper-case .md file");
  return null;
}

function matchParts(parts: readonly string[], raws: readonly string[]): ProtectedMatch | null {
  for (const r of RULES) {
    if (matchRule(parts, r)) return { category: r.category, severity: r.severity, rule: r.rule, via: "path" };
  }
  return matchGeneric(parts, raws);
}

/**
 * Whether a root-relative path is in the protected list. Lexical only: it does not touch the file system, so it
 * can judge a path that does not exist yet. A path that leaves the root (`..`, an absolute path, a drive letter) is
 * `outside-worktree`; one that cannot be parsed (too long, a NUL) is `invalid-path`.
 */
export function classifyPath(relPath: string, opts: MatchOptions = {}): ProtectedMatch | null {
  if (typeof relPath !== "string") return { category: "invalid-path", severity: "high", rule: "not a string", via: "path" };
  if (/^(?:[\\/]|[a-zA-Z]:)/.test(relPath)) return { category: "outside-worktree", severity: "high", rule: "absolute path", via: "path" };
  const sp = split(relPath);
  if (sp === null) return { category: "invalid-path", severity: "high", rule: "unusable path", via: "path" };
  if (sp.escapes) return { category: "outside-worktree", severity: "high", rule: "leaves the worktree", via: "path" };
  return matchParts(sp.parts, sp.raws) ?? matchExtra(sp.parts, opts.extraPaths);
}

const MAX_HOPS = 40;

function components(p: string): { root: string; rest: string[] } {
  const { root } = parse(p);
  return { root, rest: p.slice(root.length).split(/[\\/]+/).filter((x) => x !== "") };
}

/**
 * Like `classifyPath`, and also follows symlinks on disk: a path whose resolution lands in a protected location is
 * reported with `via: "symlink"`, one that lands outside `root` is `outside-worktree`, and a link chain longer than
 * 40 hops is `invalid-path`. Dangling links resolve to where they point. Resolution is a snapshot of the file
 * system, so it is advisory for highlighting; it is not a guard against a link swapped later. Hard links cannot
 * be told from a path.
 */
export async function classifyPathResolved(root: string, path: string, opts: MatchOptions = {}): Promise<ProtectedMatch | null> {
  const rel = isAbsolute(path) ? relative(root, path) : path;
  const lexical = classifyPath(rel, opts);
  if (lexical !== null) return lexical;
  const realRoot = await realish(root);
  let cur = realRoot;
  const queue = rel.split(/[\\/]+/).filter((x) => x !== "" && x !== ".");
  let hops = 0;
  while (queue.length > 0) {
    const part = queue.shift() as string;
    if (part === "..") {
      cur = dirname(cur);
      continue;
    }
    const next = join(cur, part);
    let st;
    try {
      st = await lstat(next);
    } catch {
      cur = next;
      continue;
    }
    if (!st.isSymbolicLink()) {
      cur = next;
      continue;
    }
    if (++hops > MAX_HOPS) return { category: "invalid-path", severity: "high", rule: "symlink loop", via: "symlink" };
    let target;
    try {
      target = await readlink(next);
    } catch {
      return { category: "invalid-path", severity: "high", rule: "unreadable link", via: "symlink" };
    }
    if (isAbsolute(target)) {
      const c = components(target);
      cur = c.root;
      queue.unshift(...c.rest);
    } else {
      queue.unshift(...target.split(/[\\/]+/).filter((x) => x !== "" && x !== "."));
    }
  }
  const finalRel = relative(realRoot, cur);
  if (finalRel === ".." || finalRel.startsWith("../") || finalRel.startsWith("..\\") || isAbsolute(finalRel)) {
    return hops > 0 ? { category: "outside-worktree", severity: "high", rule: "link leaves the worktree", via: "symlink" } : null;
  }
  const hit = classifyPath(finalRel, opts);
  if (hit === null) return null;
  return hops > 0 ? { ...hit, via: "symlink", resolved: finalRel } : hit;
}
