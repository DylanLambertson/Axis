// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { readPinnedFile, underRealDirs } from './fsSafe.js';
import { isOutsideRel } from './pathGuard.js';

/** Stored `text` is capped so a huge hook cannot bloat the baseline. */
const MAX_TEXT_BYTES = 64 * 1024;

export interface GitSnapFile {
  readonly sha256: string;
  readonly size: number;
  readonly exec: boolean;
  /** Full text for the before/after diff (omitted for large or binary files). */
  readonly text?: string;
  /**
   * Set when the content was not read: `changed` (it stopped being the lstat-ed
   * regular file while it was read; retry) or `unsupported` (over the file or
   * byte budget). The digest is then random, so the entry always drifts, and
   * such a snapshot is never stored as a baseline.
   */
  readonly unreadable?: 'changed' | 'unsupported';
}

export interface GitSnapConfigEntry {
  readonly key: string;
  readonly value: string;
  readonly scope: string;
  readonly origin: string;
}

/**
 * GIT-SNAP-1 (policies 6.4): content hashes plus text of the common-dir guard
 * set. Paths are relative to the common dir with forward slashes.
 */
export interface GitSnapshot {
  readonly version: 1;
  readonly takenAt: string;
  readonly files: Readonly<Record<string, GitSnapFile>>;
  readonly config: readonly GitSnapConfigEntry[];
}

export interface DriftItem {
  /** `file:<relpath>` or `config:<key>`. */
  readonly id: string;
  readonly kind: 'file' | 'config';
  readonly change: 'added' | 'removed' | 'modified';
  readonly before?: string;
  readonly after?: string;
}

/** Exact config keys that execute code, redirect git or change what it trusts. Lowercase. */
const WATCHED_KEYS = new Set([
  'core.hookspath', 'core.fsmonitor', 'core.sshcommand', 'core.pager', 'core.editor',
  'sequence.editor', 'core.askpass', 'core.gitproxy', 'gpg.program',
]);

/** Whole sections watched by prefix. `alias.` covers `!shell` aliases. */
const WATCHED_PREFIXES = [
  'filter.', 'diff.', 'include.', 'includeif.', 'credential.', 'uploadpack.', 'alias.',
];

/** Watched keys with a free-form subsection in the middle. */
const WATCHED_PATTERNS: readonly RegExp[] = [
  /^url\..+\.(push)?insteadof$/,
  /^remote\..+\.(url|pushurl|uploadpack|receivepack|vcs|proxy)$/,
  /^gpg\..+\.program$/,
  /^merge\..+\.driver$/,
  /^protocol\.(.+\.)?allow$/,
];

export function isWatchedConfigKey(key: string): boolean {
  const k = key.toLowerCase();
  return WATCHED_KEYS.has(k) || WATCHED_PREFIXES.some((p) => k.startsWith(p)) ||
    WATCHED_PATTERNS.some((re) => re.test(k));
}

/** Only repository-level scopes count; global/system config is out of scope (ADR 0004). */
function isRepoScope(scope: string): boolean {
  return scope === 'local' || scope === 'worktree';
}

/** Every repository-scope entry of `git config --show-origin --show-scope --null --list`. */
export function parseConfigAll(stdout: string): GitSnapConfigEntry[] {
  const parts = stdout.split('\0');
  const out: GitSnapConfigEntry[] = [];
  for (let i = 0; i + 2 < parts.length; i += 3) {
    const scope = parts[i] as string;
    const origin = parts[i + 1] as string;
    const kv = parts[i + 2] as string;
    const nl = kv.indexOf('\n');
    const key = nl === -1 ? kv : kv.slice(0, nl);
    const value = nl === -1 ? '' : kv.slice(nl + 1);
    if (isRepoScope(scope)) out.push({ key, value, scope, origin });
  }
  return out;
}

export function watchedEntries(all: readonly GitSnapConfigEntry[]): GitSnapConfigEntry[] {
  return all.filter((e) => isWatchedConfigKey(e.key));
}

/** Parses the config listing and keeps only watched repository-scope entries. */
export function parseConfigList(stdout: string): GitSnapConfigEntry[] {
  return watchedEntries(parseConfigAll(stdout));
}

function originFile(origin: string, cwd: string): string | null {
  if (!origin.startsWith('file:')) return null;
  return path.resolve(cwd, origin.slice(5));
}

/**
 * Files that config includes pull in: the targets of `include.path` and
 * `includeIf.*.path` (resolved against the including file), plus every other
 * file that actually contributed a repository-scope entry.
 */
export function includedConfigFiles(
  all: readonly GitSnapConfigEntry[],
  cwd: string,
  primary: ReadonlySet<string>,
  home: string,
): string[] {
  const found = new Set<string>();
  for (const e of all) {
    const origin = originFile(e.origin, cwd);
    if (origin && !primary.has(origin)) found.add(origin);
    if (/^include(if\..+)?\.path$/i.test(e.key) && origin) {
      const v = e.value;
      const target = v.startsWith('~/') ? path.join(home, v.slice(2)) : path.resolve(path.dirname(origin), v);
      if (!primary.has(target)) found.add(target);
    }
  }
  return [...found].sort();
}

/** Most files read from one guard directory tree (hooks, core.hooksPath) per snapshot. */
const MAX_HOOK_DIR_FILES = 2000;
/** Most bytes read per snapshot call; a file that does not fit is not read. */
const MAX_GUARD_BYTES = 16 * 1024 * 1024;

interface Budget {
  files: number;
  bytes: number;
}
const newBudget = (): Budget => ({ files: MAX_HOOK_DIR_FILES, bytes: MAX_GUARD_BYTES });

function unread(kind: 'changed' | 'unsupported', exec: boolean, text: string): GitSnapFile {
  // A random digest matches no content and no later read, so the entry always shows as drift.
  return { sha256: createHash('sha256').update(randomBytes(32)).digest('hex'), size: 0, exec, text, unreadable: kind };
}

function linkEntry(target: string): GitSnapFile {
  const buf = Buffer.from('symlink:' + target);
  const isText = buf.length <= MAX_TEXT_BYTES && !buf.includes(0);
  return { sha256: createHash('sha256').update(buf).digest('hex'), size: buf.length, exec: false, ...(isText ? { text: buf.toString('utf8') } : {}) };
}

/**
 * Records `root/sub` (`sub` uses `/`) under `key`. A symlink is recorded as
 * its target, never followed. If a directory between `root` and the file is a
 * symlink, that link is recorded instead and nothing is read through it
 * (O_NOFOLLOW guards only the last component). A regular file is streamed
 * through `readPinnedFile`, within the byte budget; FIFOs and devices are skipped.
 */
async function hashFile(root: string, sub: string, key: string, out: Record<string, GitSnapFile>, budget: Budget): Promise<void> {
  if (!(await underRealDirs(root, sub))) {
    const parts = sub.split('/');
    for (let i = 1; i < parts.length; i++) {
      const dir = path.join(root, ...parts.slice(0, i));
      const st = await fs.lstat(dir).catch(() => null);
      if (st?.isSymbolicLink()) {
        out[key] = linkEntry(await fs.readlink(dir));
        return;
      }
      if (!st?.isDirectory()) return; // the path does not exist for git either
    }
    return;
  }
  const abs = path.join(root, sub);
  let st;
  try {
    st = await fs.lstat(abs);
  } catch {
    return;
  }
  const exec = (st.mode & 0o111) !== 0;
  if (st.isSymbolicLink()) {
    out[key] = { ...linkEntry(await fs.readlink(abs)), exec };
    return;
  }
  if (!st.isFile()) return;
  if (st.size > budget.bytes) {
    out[key] = unread('unsupported', exec, `<${st.size} bytes: over the read budget, not read>`);
    return;
  }
  budget.bytes -= st.size;
  // Agent-writable: never a blocking open, never through a link, never more than lstat saw (NS-5, R4-1).
  const h = createHash('sha256');
  const head: Buffer[] = [];
  let kept = 0;
  const n = await readPinnedFile(root, sub, st, st.size, (c) => {
    h.update(c);
    if (kept <= MAX_TEXT_BYTES) {
      head.push(c);
      kept += c.length;
    }
  });
  if (n === null) {
    out[key] = unread('changed', exec, '<changed while it was read>');
    return;
  }
  const buf = Buffer.concat(head);
  const isText = n <= MAX_TEXT_BYTES && !buf.includes(0);
  out[key] = { sha256: h.digest('hex'), size: n, exec, ...(isText ? { text: buf.toString('utf8') } : {}) };
}

/**
 * Records the tree at `root/sub` under `prefix`. A symlinked or non-directory
 * `sub` is recorded as an entry and never walked. Stops at the budget's file
 * count, during the walk, leaving a `<truncated>` entry that always drifts.
 */
async function walk(root: string, sub: string, prefix: string, out: Record<string, GitSnapFile>, budget: Budget): Promise<void> {
  const st = await fs.lstat(path.join(root, sub)).catch(() => null);
  if (!st) return;
  if (!st.isDirectory() || !(await underRealDirs(root, `${sub}/x`))) {
    await hashFile(root, sub, prefix, out, budget);
    return;
  }
  let entries;
  try {
    entries = await fs.readdir(path.join(root, sub), { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (budget.files <= 0) {
      out[`${prefix}/<truncated>`] = unread('unsupported', false, `<more than ${MAX_HOOK_DIR_FILES} files: the rest was not read>`);
      return;
    }
    budget.files--;
    // Each entry goes through hashFile/walk, which re-check every parent: a directory swapped for a link is not followed.
    if (e.isDirectory()) await walk(root, `${sub}/${e.name}`, `${prefix}/${e.name}`, out, budget);
    else await hashFile(root, `${sub}/${e.name}`, `${prefix}/${e.name}`, out, budget);
  }
}

/** Reads the file part of the guard set. */
export async function snapshotGuardFiles(commonDir: string): Promise<Record<string, GitSnapFile>> {
  const files: Record<string, GitSnapFile> = {};
  const budget = newBudget();
  await hashFile(commonDir, 'config', 'config', files, budget);
  await hashFile(commonDir, 'config.worktree', 'config.worktree', files, budget);
  await hashFile(commonDir, 'info/attributes', 'info/attributes', files, budget);
  await walk(commonDir, 'hooks', 'hooks', files, budget);
  let linked: string[] = [];
  if (await underRealDirs(commonDir, 'worktrees/x')) {
    try {
      linked = await fs.readdir(path.join(commonDir, 'worktrees'));
    } catch {
      // no linked worktrees yet
    }
  }
  for (const name of linked.sort().slice(0, MAX_HOOK_DIR_FILES)) {
    await hashFile(commonDir, `worktrees/${name}/config.worktree`, `worktrees/${name}/config.worktree`, files, budget);
  }
  return files;
}

export interface ExtraFileSources {
  /** Absolute worktree root (holds the `.git` file). */
  readonly workTree: string;
  /** This worktree's admin dir (holds `commondir` and `gitdir`). */
  readonly gitDir: string;
  readonly commonDir: string;
  readonly includeFiles: readonly string[];
  /** Effective core.hooksPath value from repository config, if any. */
  readonly hooksPath: string | null;
}

/**
 * Redirection and indirection files: the worktree's `.git` file, its admin
 * dir's `commondir` and `gitdir`, config include targets, and the contents of
 * a core.hooksPath directory that resolves inside the worktree.
 */
export async function snapshotExtraFiles(
  files: Record<string, GitSnapFile>,
  src: ExtraFileSources,
): Promise<void> {
  const budget = newBudget();
  await hashFile(src.workTree, '.git', 'worktree/.git', files, budget);
  const adminName = path.relative(src.commonDir, src.gitDir).split(path.sep).join('/');
  if (adminName && !isOutsideRel(path.relative(src.commonDir, src.gitDir))) {
    await hashFile(src.gitDir, 'commondir', `${adminName}/commondir`, files, budget);
    await hashFile(src.gitDir, 'gitdir', `${adminName}/gitdir`, files, budget);
  }
  for (const f of src.includeFiles) {
    // git reads an include through any links in its path, so read the canonical path; a
    // directory swapped for a link after that is caught by the parent re-check.
    const real = await fs.realpath(f).catch(() => null);
    if (!real) continue;
    const top = path.parse(real).root;
    await hashFile(top, path.relative(top, real).split(path.sep).join('/'), `include:${f}`, files, budget);
  }
  if (src.hooksPath) {
    const dir = path.resolve(src.workTree, src.hooksPath);
    const rel = path.relative(src.workTree, dir);
    if (rel !== '' && !isOutsideRel(rel)) {
      const sub = rel.split(path.sep).join('/');
      await walk(src.workTree, sub, `hookspath:${sub}`, files, budget);
    }
  }
}

export function buildGitSnapshot(
  files: Record<string, GitSnapFile>,
  config: readonly GitSnapConfigEntry[],
  takenAt: Date,
): GitSnapshot {
  return { version: 1, takenAt: takenAt.toISOString(), files, config };
}

function groupConfig(entries: readonly GitSnapConfigEntry[]): Map<string, string> {
  const grouped = new Map<string, string[]>();
  for (const e of entries) {
    const id = e.key.toLowerCase();
    const list = grouped.get(id) ?? [];
    list.push(`[${e.scope}] ${e.value}`);
    grouped.set(id, list);
  }
  return new Map([...grouped].map(([k, v]) => [k, v.join('\n')]));
}

function change(
  id: string,
  kind: DriftItem['kind'],
  before: string | undefined,
  after: string | undefined,
): DriftItem {
  const c = before === undefined ? 'added' : after === undefined ? 'removed' : 'modified';
  return {
    id,
    kind,
    change: c,
    ...(before !== undefined ? { before } : {}),
    ...(after !== undefined ? { after } : {}),
  };
}

/** Compares a current snapshot against the baseline. Empty result means no drift. */
export function diffGitSnapshots(baseline: GitSnapshot, current: GitSnapshot): DriftItem[] {
  const items: DriftItem[] = [];
  const names = new Set([...Object.keys(baseline.files), ...Object.keys(current.files)]);
  for (const name of [...names].sort()) {
    const a = baseline.files[name];
    const b = current.files[name];
    if (a && b && a.sha256 === b.sha256 && a.exec === b.exec) continue;
    const show = (f: GitSnapFile | undefined): string | undefined =>
      f === undefined ? undefined : (f.text ?? `<${f.size} bytes sha256:${f.sha256}>`);
    items.push(change(`file:${name}`, 'file', show(a), show(b)));
  }
  const ca = groupConfig(baseline.config);
  const cb = groupConfig(current.config);
  for (const key of [...new Set([...ca.keys(), ...cb.keys()])].sort()) {
    const a = ca.get(key);
    const b = cb.get(key);
    if (a !== b) items.push(change(`config:${key}`, 'config', a, b));
  }
  return items;
}

/**
 * Drift that changes what git may execute or where it points: any watched
 * config key, attributes, include targets, and the redirection files. Daemon
 * writes refuse while any of these is unacknowledged.
 */
export function isExecutionDrift(item: DriftItem): boolean {
  const id = item.id;
  return item.kind === 'config' || id === 'file:info/attributes' || id.startsWith('file:include:') ||
    id === 'file:worktree/.git' || id.endsWith('/commondir') || id.endsWith('/gitdir');
}
