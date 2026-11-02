// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/** Stored `text` is capped so a huge hook cannot bloat the baseline. */
const MAX_TEXT_BYTES = 64 * 1024;

export interface GitSnapFile {
  readonly sha256: string;
  readonly size: number;
  readonly exec: boolean;
  /** Full text for the before/after diff (omitted for large or binary files). */
  readonly text?: string;
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

/** Config keys of interest, besides `filter.*` and `diff.*`. Lowercase. */
const WATCHED_KEYS = new Set(['core.hookspath', 'core.fsmonitor', 'core.sshcommand']);

export function isWatchedConfigKey(key: string): boolean {
  const k = key.toLowerCase();
  return k.startsWith('filter.') || k.startsWith('diff.') || WATCHED_KEYS.has(k);
}

/** Only repository-level scopes count; global/system config is out of scope (ADR 0004). */
function isRepoScope(scope: string): boolean {
  return scope === 'local' || scope === 'worktree';
}

/** Parses `git config --show-origin --show-scope --null --list` output. */
export function parseConfigList(stdout: string): GitSnapConfigEntry[] {
  const parts = stdout.split('\0');
  const out: GitSnapConfigEntry[] = [];
  for (let i = 0; i + 2 < parts.length; i += 3) {
    const scope = parts[i] as string;
    const origin = parts[i + 1] as string;
    const kv = parts[i + 2] as string;
    const nl = kv.indexOf('\n');
    const key = nl === -1 ? kv : kv.slice(0, nl);
    const value = nl === -1 ? '' : kv.slice(nl + 1);
    if (isRepoScope(scope) && isWatchedConfigKey(key)) out.push({ key, value, scope, origin });
  }
  return out;
}

async function hashFile(abs: string, rel: string, out: Record<string, GitSnapFile>): Promise<void> {
  let st;
  try {
    st = await fs.lstat(abs);
  } catch {
    return;
  }
  if (st.isDirectory()) return;
  let buf: Buffer;
  if (st.isSymbolicLink()) buf = Buffer.from('symlink:' + (await fs.readlink(abs)));
  else if (st.isFile()) buf = await fs.readFile(abs);
  else return;
  const isText = buf.length <= MAX_TEXT_BYTES && !buf.includes(0);
  out[rel] = {
    sha256: createHash('sha256').update(buf).digest('hex'),
    size: buf.length,
    exec: (st.mode & 0o111) !== 0,
    ...(isText ? { text: buf.toString('utf8') } : {}),
  };
}

async function walk(dir: string, rel: string, out: Record<string, GitSnapFile>): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const r = `${rel}/${e.name}`;
    if (e.isDirectory()) await walk(path.join(dir, e.name), r, out);
    else await hashFile(path.join(dir, e.name), r, out);
  }
}

/** Reads the file part of the guard set. */
export async function snapshotGuardFiles(commonDir: string): Promise<Record<string, GitSnapFile>> {
  const files: Record<string, GitSnapFile> = {};
  await hashFile(path.join(commonDir, 'config'), 'config', files);
  await hashFile(path.join(commonDir, 'config.worktree'), 'config.worktree', files);
  await hashFile(path.join(commonDir, 'info', 'attributes'), 'info/attributes', files);
  await walk(path.join(commonDir, 'hooks'), 'hooks', files);
  let linked: string[] = [];
  try {
    linked = await fs.readdir(path.join(commonDir, 'worktrees'));
  } catch {
    // no linked worktrees yet
  }
  for (const name of linked) {
    await hashFile(
      path.join(commonDir, 'worktrees', name, 'config.worktree'),
      `worktrees/${name}/config.worktree`,
      files,
    );
  }
  return files;
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
