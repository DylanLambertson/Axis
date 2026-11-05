// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Re-review 4: R4-2 (extraEnv is not allow-listed) and R4-3 (the config and symbolic-ref
// shapes allow write forms).

import assert from 'node:assert/strict';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';
import { createExecGitRunner, createHooksGuard, WorktreeError, type GitRunner } from '../src/index.js';
import { HardenedGit, runsNoFilters } from '../src/hardenedGit.js';
import { makeFixture, type Fixture } from './helpers.js';

const fixtures: Fixture[] = [];
function fresh(): Fixture {
  const f = makeFixture();
  fixtures.push(f);
  return f;
}
after(() => fixtures.forEach((f) => f.cleanup()));

describe('R4-2: extraEnv is allow-listed', () => {
  it('refuses any variable other than GIT_INDEX_FILE without calling git', async () => {
    const fx = fresh();
    const calls: string[][] = [];
    const real = createExecGitRunner();
    const spy: GitRunner = { gitPath: real.gitPath as string, run: (a, o) => { calls.push([...a]); return real.run(a, o); } };
    const git = new HardenedGit(spy, createHooksGuard('linux'));
    for (const name of ['GIT_DIR', 'GIT_CONFIG_PARAMETERS', 'GIT_EXEC_PATH', 'GIT_CONFIG_GLOBAL', 'PATH', 'git_index_file']) {
      await assert.rejects(git.run(['write-tree'], { cwd: fx.repo, extraEnv: { [name]: '/x' } }),
        (e: unknown) => e instanceof WorktreeError && e.code === 'E_INTERNAL', name);
    }
    assert.deepEqual(calls, []);
    const idx = path.join(fx.tmp, 'idx');
    await git.run(['read-tree', 'HEAD'], { cwd: fx.repo, extraEnv: { GIT_INDEX_FILE: idx } });
    assert.equal(calls.length, 1);
  });
});

describe('R4-3: config and symbolic-ref take only their read forms', () => {
  it('refuses write forms and accepts exactly what the manager runs', () => {
    for (const no of [
      ['config', '--null', 'core.hooksPath', '/tmp/h'], ['config', '--null', '--get-regexp', '^filter\\.'],
      ['config', '--null', '--list', 'extra'], ['config', '--null', '--name-only', '--list'], ['config', '--list'],
      ['symbolic-ref', 'HEAD', 'refs/heads/x'], ['symbolic-ref', '-q', 'HEAD', 'refs/heads/x'], ['symbolic-ref', '-d', 'HEAD'],
      ['symbolic-ref', '-q', '--', 'HEAD', 'refs/heads/x'],
    ]) assert.equal(runsNoFilters(no), false, no.join(' '));
    for (const ok of [
      ['config', '--show-origin', '--show-scope', '--null', '--list'],
      ['symbolic-ref', '-q', 'HEAD'], ['symbolic-ref', '-q', '--short', 'HEAD'],
    ]) assert.equal(runsNoFilters(ok), true, ok.join(' '));
  });
});
