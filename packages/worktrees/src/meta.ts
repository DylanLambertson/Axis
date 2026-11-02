// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { WorktreeError } from './errors.js';
import type { GitSnapshot } from './gitSnap.js';

export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export const SlugSchema = z.string().regex(SLUG_PATTERN, 'slug must be 1-64 chars of a-z, 0-9 and "-", not starting or ending with "-"');
export const IdSchema = z.string().regex(ID_PATTERN);

export const WorkspaceMetaSchema = z.strictObject({
  version: z.literal(1),
  id: IdSchema,
  slug: SlugSchema,
  branch: z.string().min(1),
  baseRef: z.string().min(1),
  baseSha: z.string().regex(/^[0-9a-f]{40,64}$/),
  /** Full ref name of the base branch when the base was a branch, else null. */
  baseBranch: z.string().nullable(),
  createdAt: z.string(),
  state: z.enum(['ready', 'finalised']),
  outcome: z.enum(['merged', 'archived', 'abandoned']).nullable(),
});
export type WorkspaceMeta = z.infer<typeof WorkspaceMetaSchema>;

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
    text = await fs.readFile(path.join(gitDir, META_FILE), 'utf8');
  } catch {
    return null;
  }
  const parsed = WorkspaceMetaSchema.safeParse(JSON.parse(text));
  if (!parsed.success) {
    throw new WorktreeError('E_INVALID', 'workspace record is corrupt', { gitDir });
  }
  return parsed.data;
}

export async function writeMeta(gitDir: string, meta: WorkspaceMeta): Promise<void> {
  await writeAtomic(path.join(gitDir, META_FILE), JSON.stringify(WorkspaceMetaSchema.parse(meta), null, 2));
}

export async function readBaseline(gitDir: string): Promise<GitSnapshot | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(gitDir, BASELINE_FILE), 'utf8')) as GitSnapshot;
  } catch {
    return null;
  }
}

export async function writeBaseline(gitDir: string, snap: GitSnapshot): Promise<void> {
  await writeAtomic(path.join(gitDir, BASELINE_FILE), JSON.stringify(snap));
}
