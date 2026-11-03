// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { WorktreeError } from './errors.js';
import { readRegularFile } from './fsSafe.js';
import type { GitSnapshot } from './gitSnap.js';

export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export const SlugSchema = z.string().regex(SLUG_PATTERN, 'slug must be 1-64 chars of a-z, 0-9 and "-", not starting or ending with "-"');
export const IdSchema = z.string().regex(ID_PATTERN);

export const WorkspaceMetaSchema = z
  .strictObject({
    version: z.literal(1),
    id: IdSchema,
    slug: SlugSchema,
    branch: z.string().min(1),
    baseRef: z.string().min(1),
    baseSha: z.string().regex(/^[0-9a-f]{40,64}$/),
    /** Full ref name of the base branch when the base was a branch, else null. */
    baseBranch: z.string().regex(/^refs\/heads\/[^\s\0-\x1f\x7f-][^\s\0-\x1f\x7f]*$/).nullable(),
    /** Commit the run-base ref pointed at when Axis wrote it; restore refuses if the ref moved. */
    runBaseSha: z.string().regex(/^[0-9a-f]{40,64}$/),
    createdAt: z.string(),
    state: z.enum(['READY', 'FINALISED']),
    outcome: z.enum(['merged', 'archived', 'abandoned']).nullable(),
  })
  .refine((m) => m.branch === `axis/${m.slug}`, { message: 'branch must be axis/<slug>' });
export type WorkspaceMeta = z.infer<typeof WorkspaceMetaSchema>;

const SnapFileSchema = z.strictObject({
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  size: z.number().int().min(0),
  exec: z.boolean(),
  text: z.string().optional(),
});
export const GitSnapshotSchema = z.strictObject({
  version: z.literal(1),
  takenAt: z.string(),
  files: z.record(z.string(), SnapFileSchema),
  config: z.array(z.strictObject({ key: z.string(), value: z.string(), scope: z.string(), origin: z.string() })),
});

const META_FILE = 'axis-workspace.json';
const BASELINE_FILE = 'axis-gitsnap.json';

async function writeAtomic(file: string, data: string): Promise<void> {
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmp, data, { mode: 0o600 });
  await fs.rename(tmp, file);
}

/**
 * Per-worktree records live in git's private admin directory for the worktree
 * (`<common>/worktrees/<name>/`), which `git worktree remove` deletes with the
 * worktree. The daemon journal (task B3) supersedes this as the source of
 * truth; the file form keeps this package self-contained and testable.
 */
export async function readMeta(gitDir: string): Promise<WorkspaceMeta | null> {
  let text: string;
  try {
    text = await readRegularFile(path.join(gitDir, META_FILE));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    // a FIFO, device link, oversized or unreadable record is corrupt, never "missing" and never a hang
    throw new WorktreeError('E_INTERNAL', 'workspace record is corrupt', { reason: 'corrupt-record' });
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new WorktreeError('E_INTERNAL', 'workspace record is corrupt', { reason: 'corrupt-record' });
  }
  const parsed = WorkspaceMetaSchema.safeParse(json);
  if (!parsed.success) {
    throw new WorktreeError('E_INTERNAL', 'workspace record is corrupt', { reason: 'corrupt-record' });
  }
  return parsed.data;
}

export async function writeMeta(gitDir: string, meta: WorkspaceMeta): Promise<void> {
  await writeAtomic(path.join(gitDir, META_FILE), JSON.stringify(WorkspaceMetaSchema.parse(meta), null, 2));
}

export async function readBaseline(gitDir: string): Promise<GitSnapshot | null> {
  let text: string;
  try {
    text = await readRegularFile(path.join(gitDir, BASELINE_FILE));
  } catch {
    return null;
  }
  try {
    const parsed = GitSnapshotSchema.safeParse(JSON.parse(text));
    return parsed.success ? (parsed.data as GitSnapshot) : null; // unusable baseline == missing: fail closed
  } catch {
    return null;
  }
}

export async function writeBaseline(gitDir: string, snap: GitSnapshot): Promise<void> {
  await writeAtomic(path.join(gitDir, BASELINE_FILE), JSON.stringify(snap));
}
