// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

import { existsSync } from 'node:fs';
import { devNull } from 'node:os';
import * as path from 'node:path';

/**
 * The one definition of "this commit is in the base branch" (ticket FU-WT-BASE), used by the manager's finalise and by the
 * daemon's repair of an interrupted finalise. Everything it reads lives in a repository a finished run can write, so:
 *  - the recorded name is looked up EXACTLY (`show-ref --verify`), never through `rev-parse` name expansion, so a deleted
 *    base plus a lookalike `refs/heads/refs/heads/<name>` is "no base", not a base;
 *  - replace refs are off (`GIT_NO_REPLACE_OBJECTS`) and grafts are inert twice over: a graft file in the repository is a
 *    refusal, and `GIT_GRAFT_FILE` names the empty device, so no git version can read one;
 *  - the base must still descend from the tip it had at create (FU-WT-BASE2) and must not be a symbolic ref, so a base reset
 *    to an unrelated commit, rewritten base history, or a base pointed at another branch is `base-rewritten`, never merged;
 *    a missing tip (a workspace made before it was recorded) is "no base". This does NOT stop a run that fast-forwards the
 *    base onto its own commits: they descend from the tip, exactly like a real merge (threat model WT-3).
 */
export const MERGED_CHECK_ENV: Readonly<Record<string, string>> = { GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: devNull };

export type MergedVerdict = 'merged' | 'not-merged' | 'no-base-branch' | 'base-rewritten';

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const BASE = /^refs\/heads\/[!-~]+$/;

export interface MergedProbe {
  readonly cwd: string;
  run(args: readonly string[], extraEnv: Readonly<Record<string, string>>): Promise<{ readonly code: number; readonly stdout: string }>;
}

export async function verifyMerged(
  probe: MergedProbe, head: string, baseBranch: string | null | undefined, baseTip: string | null | undefined,
): Promise<MergedVerdict> {
  if (!baseBranch || !BASE.test(baseBranch) || baseBranch.includes('..')) return 'no-base-branch';
  if (!baseTip || !SHA.test(baseTip)) return 'no-base-branch';
  if (!SHA.test(head)) return 'not-merged';
  const env = MERGED_CHECK_ENV;
  const where = await probe.run(['rev-parse', '--git-path', 'info/grafts'], {}) // without the graft variable, which would answer with its own value;
  const grafts = where.stdout.trim();
  // Unknown location, or a graft file present: the answer cannot be trusted, so it is never "merged".
  if (where.code !== 0 || grafts === '' || existsSync(path.resolve(probe.cwd, grafts))) return 'not-merged';
  const ref = await probe.run(['show-ref', '--verify', baseBranch], env);
  const m = /^([0-9a-f]{40}(?:[0-9a-f]{24})?) (\S+)\n?$/.exec(ref.stdout);
  if (ref.code !== 0 || !m || m[2] !== baseBranch) return 'no-base-branch';
  // `show-ref` resolves a symbolic ref silently; exit 0 here means the base names another ref, which no merge does.
  if ((await probe.run(['symbolic-ref', '-q', baseBranch], env)).code === 0) return 'base-rewritten';
  // Any answer but "yes" (no, or the tip object is gone) is a refusal.
  if ((await probe.run(['merge-base', '--is-ancestor', baseTip, m[1] as string], env)).code !== 0) return 'base-rewritten';
  const anc = await probe.run(['merge-base', '--is-ancestor', head, m[1] as string], env);
  return anc.code === 0 ? 'merged' : 'not-merged';
}
