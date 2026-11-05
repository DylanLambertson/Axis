// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Re-review 5: R5-2 (a baseline taken while a guard file is unread stores a random digest).

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';
import { WorktreeError } from '../src/index.js';
import { buildGitSnapshot, type GitSnapFile } from '../src/gitSnap.js';
import { writeBaseline } from '../src/meta.js';
import { makeFixture, type Fixture } from './helpers.js';

const fixtures: Fixture[] = [];
function fresh(): Fixture {
  const f = makeFixture();
  fixtures.push(f);
  return f;
}
after(() => fixtures.forEach((f) => f.cleanup()));

function baselines(fx: Fixture): string[] {
  const admin = path.join(fx.repo, '.git', 'worktrees');
  return readdirSync(admin).map((d) => path.join(admin, d, 'axis-gitsnap.json')).filter((f) => existsSync(f));
}

describe('R5-2: a baseline is never persisted with an unread guard file', () => {
  const entry = (unreadable: GitSnapFile['unreadable']): GitSnapFile =>
    ({ sha256: 'a'.repeat(64), size: 0, exec: false, ...(unreadable ? { unreadable } : {}) });

  it('refuses a file that changed while it was read with a retryable E_CONFLICT', async () => {
    const fx = fresh();
    const snap = buildGitSnapshot({ config: entry(undefined), 'info/attributes': entry('changed') }, [], new Date());
    await assert.rejects(writeBaseline(fx.tmp, snap), (e: unknown) =>
      e instanceof WorktreeError && e.code === 'E_CONFLICT' && e.details['reason'] === 'guard-file-changing' && e.details['retryable'] === true);
    assert.equal(existsSync(path.join(fx.tmp, 'axis-gitsnap.json')), false);
  });

  it('acknowledgeDrift refuses while the guard set is over budget, and keeps the old baseline', async () => {
    const fx = fresh();
    const ws = await fx.manager.create({ repoPath: fx.repo, slug: 'agent' });
    const before = baselines(fx).map((b) => readFileSync(b, 'utf8'));
    writeFileSync(path.join(fx.repo, '.git', 'hooks', 'huge'), Buffer.alloc(17 * 1024 * 1024, 0x61));
    await assert.rejects(fx.manager.acknowledgeDrift(ws.path), (e: unknown) =>
      e instanceof WorktreeError && e.code === 'E_POLICY_DENIED' && e.details['reason'] === 'guard-set-unreadable');
    assert.deepEqual(baselines(fx).map((b) => readFileSync(b, 'utf8')), before);
  });
});
