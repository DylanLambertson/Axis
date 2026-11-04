// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { dirname, join, resolve } from "node:path";
import { displayValue, escapeDisplay, secretNamed } from "./display.js";
import { record, type Ctx } from "./entry.js";
import { parseGitConfig, type ConfigEntry } from "./gitconfig.js";
import type { GitConfigEntry, GitView } from "./git.js";
import { locate, realish, resolveUserPath } from "./paths.js";
import { PATH_SETTINGS, classifySetting } from "./settings.js";
import type { Setting } from "./types.js";

/** A path some setting points git at: read and hashed whatever its value looks like. */
export interface PathTarget {
  readonly kind: "hooks" | "attributes";
  readonly path: string;
}

export interface ConfigInput {
  readonly commonDir: string;
  readonly worktreePath: string;
  readonly worktreeRoots: readonly string[];
  /** Directory names under `$GIT_COMMON_DIR/worktrees`. */
  readonly worktreeNames: readonly string[];
  readonly git: GitView;
}

interface Parsed {
  readonly id: string;
  readonly path: string;
  readonly entries: readonly ConfigEntry[];
}

const keyOf = (e: ConfigEntry): string => `${e.section}${e.subsection === null ? "" : `.${e.subsection}`}.${e.name}`;

/** Bytes (as latin1 text) back to a string, or null when they are not valid UTF-8: such a name cannot be used as a path. */
export function fromLatin1(s: string): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(s, "latin1"));
  } catch {
    return null;
  }
}

/** The same list `n` times over: a file included twice is listed twice by git. */
function repeatsOf(g: readonly (readonly [string, string | null])[], m: readonly (readonly [string, string | null])[]): boolean {
  if (m.length === 0) return g.length === 0;
  if (g.length % m.length !== 0) return false;
  return g.every((x, i) => {
    const y = m[i % m.length] as readonly [string, string | null];
    return x[0] === y[0] && x[1] === y[1];
  });
}

/** Splits git's `a.b.c` key: the section is up to the first dot, the name after the last, the subsection between. */
function splitKey(key: string): { section: string; sub: string | null; name: string } | null {
  const first = key.indexOf(".");
  const last = key.lastIndexOf(".");
  if (first <= 0 || last === key.length - 1) return null;
  return { section: key.slice(0, first), sub: last > first ? key.slice(first + 1, last) : null, name: key.slice(last + 1) };
}

/**
 * Reads `config`, every `config.worktree` and every file git says it read, hashes them all, and extracts the
 * settings. What decides WHAT is hashed or resolved comes from git (`config --list --show-origin`, includes followed
 * by git itself); this package's parser is a second opinion. When the two differ on any file, or the parser rejects a
 * line, the snapshot is blocking-incomplete: it can never read as clean. The parser also finds include files git did
 * not read (missing, or an `includeIf` that is false today), which are hashed too so that their appearance shows.
 */
export async function collectConfigs(ctx: Ctx, input: ConfigInput): Promise<PathTarget[]> {
  const files = new Map<string, Parsed>();
  const bad = (id: string, reason: string): void => void ctx.incomplete.push({ id, reason, blocking: true });
  let includes = 0;

  const find = async (path: string): Promise<Parsed | undefined> => {
    const hit = files.get(resolve(path));
    if (hit !== undefined) return hit;
    const real = await realish(path);
    for (const [k, v] of files) if ((await realish(k)) === real) return v;
    return undefined;
  };

  const load = async (id: string, path: string, depth: number): Promise<Parsed | undefined> => {
    const known = await find(path);
    if (known !== undefined) return known;
    const { read } = await record(ctx, id, "config", path, { parse: true });
    let entries: ConfigEntry[] = [];
    if (read.kind === "dir" || read.kind === "other") bad(id, "not a regular file");
    if (read.bytes !== null && read.kind === "file") {
      const parsed = parseGitConfig(read.bytes.toString("latin1"), ctx.limits.maxSettings * 8);
      entries = [...parsed.entries];
      if (parsed.errors > 0) bad(id, "lines the parser cannot read");
      if (parsed.truncated) bad(id, "too many entries to parse");
    }
    const p: Parsed = { id, path, entries };
    files.set(resolve(path), p);
    for (const e of entries) {
      const isInclude = (e.section === "include" && e.subsection === null) || e.section === "includeif";
      if (!isInclude || e.name !== "path" || e.value === null) continue;
      const text = fromLatin1(e.value);
      const abs = text === null ? null : resolveUserPath(text, dirname(path), ctx.homeDir);
      if (abs === null) bad(id, "include path that is not UTF-8 or that git must expand");
      else if (!files.has(abs)) {
        if (depth + 1 > ctx.limits.maxIncludeDepth) bad(id, "include depth limit");
        else if (++includes > ctx.limits.maxIncludeFiles) bad(id, "include file limit");
        else await load(`include:${escapeDisplay(abs)}`, abs, depth + 1);
      }
    }
    return p;
  };

  await load("config", join(input.commonDir, "config"), 0);
  await load("config.worktree", join(input.commonDir, "config.worktree"), 0);
  for (const name of input.worktreeNames) {
    await load(`worktrees/${escapeDisplay(name)}/config.worktree`, join(input.commonDir, "worktrees", name, "config.worktree"), 0);
  }

  const gitList = input.git.config;
  let source: { key: string; value: string | null; origin: string }[];
  if (gitList === null) {
    // Without git's answer the parser's reading is all there is: it is used for hashing, and the snapshot is incomplete.
    source = [...files.values()].flatMap((f) => f.entries.map((e) => ({ key: keyOf(e), value: e.value, origin: f.id })));
  } else {
    const byFile = new Map<string, GitConfigEntry[]>();
    for (const e of gitList) {
      if (e.file === null) continue;
      const list = byFile.get(e.file) ?? [];
      list.push(e);
      byFile.set(e.file, list);
    }
    const originId = new Map<string, string>();
    for (const [file, list] of byFile) {
      const text = fromLatin1(file);
      if (text === null) {
        bad("config", "a config file name that is not UTF-8");
        continue;
      }
      let parsed = await find(text);
      if (parsed === undefined) {
        bad(`include:${escapeDisplay(text)}`, "git read a file the parser did not find");
        parsed = await load(`include:${escapeDisplay(text)}`, text, 1);
      }
      if (parsed === undefined) continue;
      originId.set(file, parsed.id);
      const mine = parsed.entries.map((e) => [keyOf(e), e.value] as const);
      if (!repeatsOf(list.map((e) => [e.key, e.value] as const), mine)) bad(parsed.id, "parser and git disagree");
    }
    source = gitList.map((e) => ({ key: e.key, value: e.value, origin: e.file === null ? "other" : (originId.get(e.file) ?? "other") }));
  }

  const targets: PathTarget[] = [];
  let full = false;
  // Targets first, by key: a cap on the displayed settings never decides what is hashed.
  for (const s of source) {
    const k = splitKey(s.key);
    if (k === null) continue;
    const cls = classifySetting(k.section, k.sub, k.name);
    if (cls === null) continue;
    const text = s.value === null ? null : fromLatin1(s.value);
    let note: Setting["note"] = null;
    const pathKind = k.sub === null ? PATH_SETTINGS.get(`${k.section}.${k.name}`) : undefined;
    if (pathKind !== undefined && s.value !== null && s.value !== "") {
      const abs = text === null ? null : resolveUserPath(text, input.worktreePath, ctx.homeDir);
      if (abs === null) {
        note = "unresolved";
        bad(s.origin, `${k.section}.${k.name} is not UTF-8 or needs git to expand it`);
      } else {
        note = await locate(abs, input.worktreeRoots);
        targets.push({ kind: pathKind, path: abs });
      }
    }
    if (ctx.settings.length >= ctx.limits.maxSettings) {
      full = true;
      continue;
    }
    const subShown = k.sub === null ? "" : `.${displayValue(Buffer.from(k.sub, "latin1").toString("utf8"), 200)}`;
    const shown = text ?? (s.value === null ? null : Buffer.from(s.value, "latin1").toString("utf8"));
    const value = shown === null ? null : secretNamed(k.name) ? "[REDACTED]" : displayValue(shown);
    ctx.settings.push({ key: `${k.section}${subShown}.${k.name}`, value, origin: s.origin, label: cls.label, severity: cls.severity, note });
  }
  // A setting that is not listed could be the one that matters: this blocks.
  if (full) bad("settings", "more settings than the snapshot lists");
  return targets;
}
