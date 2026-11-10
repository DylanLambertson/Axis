// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Re-review attack suite: the original attacks replayed against the daemon (B-1, B-2, NB-1, NB-2, S-1 to S-6).

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { createExecGitRunner, WorktreeManager, type GitRunner } from '../src/index.js';
import {  sh, write, type Fixture, exp } from './helpers.js';
import { fresh, raw, statDirty, everyBlobPath, fired } from './rereview-support.js';
// --------------------------------------------------------------------------------------------
describe('re-review B-1: planted hooks never run in the daemon', () => {
  it('hooks in .git/hooks and in a configured core.hooksPath dir (in TMPDIR) stay inert on every path', async () => {
    const fx = fresh();
    const marker = path.join(fx.tmp, 'PWNED-hook');
    const a = await fx.manager.create({ repoPath: fx.repo, slug: 'agent' });
    const evil = path.join(os.tmpdir(), `rereview-hooks-${process.pid}`);
    mkdirSync(evil, { recursive: true });
    for (const dir of [path.join(fx.repo, '.git', 'hooks'), evil]) {
      for (const h of ['reference-transaction', 'post-checkout', 'post-index-change', 'pre-auto-gc', 'post-rewrite']) {
        writeFileSync(path.join(dir, h), `#!/bin/sh\ntouch '${marker}'\ncat >/dev/null 2>&1\nexit 0\n`);
        chmodSync(path.join(dir, h), 0o755);
      }
    }
    sh(a.path, 'config', 'core.hooksPath', evil);
    // Non-vacuity: the same plant fires for a plain git ref update.
    raw(fx.repo, fx.tmp, 'update-ref', 'refs/rereview/probe', 'HEAD');
    assert.ok(existsSync(marker), 'non-vacuity: plain git must run the planted hook');
    rmSync(marker);
    const log = await everyBlobPath(fx, fx.manager, a, marker);
    rmSync(evil, { recursive: true, force: true });
    assert.deepEqual(fired(log), [], JSON.stringify(log));
  });
});

// --------------------------------------------------------------------------------------------
type Plant = (fx: Fixture, a: string, marker: string) => { unhardened: () => void };

const clean = (m: string): string => `touch '${m}'; cat`;
const attrs = (fx: Fixture, name: string): void => write(path.join(fx.repo, '.git', 'info', 'attributes'), `* filter=${name}\n`);
const statusProbe = (fx: Fixture, a: string) => (): void => {
  statDirty(path.join(a, 'a.txt'));
  raw(a, fx.tmp, 'status', '--porcelain');
};

const plants: Record<string, Plant> = {
  'clean, common config, info/attributes': (fx, a, m) => {
    sh(a, 'config', 'filter.x.clean', clean(m)); attrs(fx, 'x');
    return { unhardened: statusProbe(fx, a) };
  },
  'smudge, common config, info/attributes': (fx, a, m) => {
    sh(a, 'config', 'filter.y.smudge', clean(m)); attrs(fx, 'y');
    return { unhardened: () => { rmSync(path.join(a, 'a.txt')); raw(a, fx.tmp, 'checkout', '--', 'a.txt'); } };
  },
  'process + required, common config': (fx, a, m) => {
    sh(a, 'config', 'filter.p.process', `sh -c "touch '${m}'; exit 1"`);
    sh(a, 'config', 'filter.p.required', 'true'); attrs(fx, 'p');
    return { unhardened: statusProbe(fx, a) };
  },
  'defined only in an include.path file': (fx, a, m) => {
    const inc = path.join(fx.tmp, 'included.cfg');
    writeFileSync(inc, `[filter "inc"]\n\tclean = "${clean(m)}"\n`);
    sh(a, 'config', 'include.path', inc); attrs(fx, 'inc');
    return { unhardened: statusProbe(fx, a) };
  },
  'defined in worktree config.worktree': (fx, a, m) => {
    sh(a, 'config', 'extensions.worktreeConfig', 'true');
    sh(a, 'config', '--worktree', 'filter.wt.clean', clean(m)); attrs(fx, 'wt');
    return { unhardened: statusProbe(fx, a) };
  },
  'attributes-only in info/attributes, driver in global ~/.gitconfig': (fx, a, m) => {
    writeFileSync(path.join(fx.tmp, '.gitconfig'), `[filter "glob"]\n\tclean = "${clean(m)}"\n`); attrs(fx, 'glob');
    return { unhardened: statusProbe(fx, a) };
  },
  '.gitattributes inside the worktree': (fx, a, m) => {
    sh(a, 'config', 'filter.ga.clean', clean(m));
    write(path.join(a, '.gitattributes'), '* filter=ga\n');
    return { unhardened: statusProbe(fx, a) };
  },
  'dotted and upper-case driver name': (fx, a, m) => {
    sh(a, 'config', 'filter.Ev.Il.clean', clean(m)); attrs(fx, 'Ev.Il');
    return { unhardened: statusProbe(fx, a) };
  },
};

describe('re-review B-2: planted filter drivers never run in the daemon', () => {
  for (const [name, plant] of Object.entries(plants)) {
    it(`${name}: inert on create, snapshot, restore, discard, finalise, remove and sweep`, async () => {
      const fx = fresh();
      // Global config lives in the fixture's HOME for both the daemon and the unhardened probe.
      const m = new WorktreeManager({
        runner: createExecGitRunner({ baseEnv: { PATH: process.env['PATH'], HOME: fx.tmp } }), worktreeRoot: fx.root,
      });
      const marker = path.join(fx.tmp, 'PWNED-filter');
      const a = await m.create({ repoPath: fx.repo, slug: 'agent' });
      const { unhardened } = plant(fx, a.path, marker);
      unhardened();
      assert.ok(existsSync(marker), 'non-vacuity: plain git must run the planted driver');
      raw(a.path, fx.tmp, 'checkout', '--', '.'); // undo the probe's edits (this may fire the driver too)
      rmSync(marker, { force: true });
      const log = await everyBlobPath(fx, m, a, marker);
      assert.deepEqual(fired(log), [], JSON.stringify(log, null, 1));
      assert.ok(log.some((l) => l.op === 'create(next workspace)' && l.outcome === 'ok'), 'create path was exercised');
    });
  }

  it('NEW BLOCKER: a filter with an EMPTY name ([filter ""]) is not neutralised', async () => {
    const fx = fresh();
    const marker = path.join(fx.tmp, 'PWNED-empty-name');
    const a = await fx.manager.create({ repoPath: fx.repo, slug: 'agent' });
    // Agent, from its own worktree: two writes to the shared common dir.
    const cfg = path.join(fx.repo, '.git', 'config');
    writeFileSync(cfg, readFileSync(cfg, 'utf8') + `[filter ""]\n\tclean = "touch '${marker}'; cat"\n`);
    attrs(fx, '');
    statDirty(path.join(a.path, 'a.txt'));
    // No baseline rewrite at all: status() has no drift guard. A UI status refresh is enough.
    await fx.manager.status(a.path, exp(a.path));
    assert.equal(existsSync(marker), false, 'empty-named clean filter executed inside daemon status()');
  });

  it('NEW BLOCKER (all paths): the empty-name filter on every blob path', async () => {
    const fx = fresh();
    const marker = path.join(fx.tmp, 'PWNED-empty-name-all');
    const a = await fx.manager.create({ repoPath: fx.repo, slug: 'agent' });
    const cfg = path.join(fx.repo, '.git', 'config');
    writeFileSync(cfg, readFileSync(cfg, 'utf8') + `[filter ""]\n\tclean = "touch '${marker}'; cat"\n\tsmudge = "touch '${marker}'; cat"\n`);
    attrs(fx, '');
    const log = await everyBlobPath(fx, fx.manager, a, marker);
    assert.deepEqual(fired(log), [], JSON.stringify(log, null, 1));
  });
});

// --------------------------------------------------------------------------------------------
describe('re-review B-2: scan-then-run TOCTOU', () => {
  it('simulated: a driver added between the per-call filter scan and the git call runs', async () => {
    const fx = fresh();
    const marker = path.join(fx.tmp, 'PWNED-race-sim');
    const real = createExecGitRunner();
    let armed = false;
    const runner: GitRunner = {
      ...(real.gitPath !== undefined ? { gitPath: real.gitPath } : {}),
      async run(args, o) {
        const res = await real.run(args, o);
        if (armed && args.includes('--get-regexp') && args.includes('^filter\\.')) {
          armed = false; // the agent's write lands right after the scan returns
          sh(fx.repo, 'config', 'filter.race.clean', `touch '${marker}'; cat`);
        }
        return res;
      },
    };
    const m = new WorktreeManager({ runner, worktreeRoot: fx.root });
    const a = await m.create({ repoPath: fx.repo, slug: 'agent' });
    attrs(fx, 'race');
    statDirty(path.join(a.path, 'a.txt'));
    armed = true;
    await m.status(a.path, exp(a.path));
    assert.equal(existsSync(marker), false, 'driver planted after the scan ran in daemon status()');
  });

  it('real time: an agent toggling .git/config in a loop wins against status() polling', async () => {
    const fx = fresh();
    const marker = path.join(fx.tmp, 'PWNED-race-real');
    const a = await fx.manager.create({ repoPath: fx.repo, slug: 'agent' });
    attrs(fx, 'race');
    const cfg = path.join(fx.repo, '.git', 'config');
    const good = readFileSync(cfg, 'utf8');
    writeFileSync(`${cfg}.good`, good);
    writeFileSync(`${cfg}.evil`, `${good}[filter "race"]\n\tclean = "touch '${marker}'; cat"\n`);
    const loop = spawn('/bin/sh', ['-c',
      `while :; do cp "${cfg}.evil" "${cfg}.e" && mv "${cfg}.e" "${cfg}"; cp "${cfg}.good" "${cfg}.g" && mv "${cfg}.g" "${cfg}"; done`],
    { stdio: 'ignore' });
    let tries = 0;
    // Control: the loop alone, with no daemon call, never creates the marker.
    await new Promise((r) => setTimeout(r, 2000));
    assert.equal(existsSync(marker), false, 'control: the toggler alone fired the driver');
    try {
      const deadline = Date.now() + 45_000;
      while (Date.now() < deadline && !existsSync(marker)) {
        statDirty(path.join(a.path, 'a.txt'));
        tries++;
        await fx.manager.status(a.path, exp(a.path)).catch(() => undefined);
      }
    } finally {
      loop.kill('SIGKILL');
      await new Promise((r) => setTimeout(r, 100));
      writeFileSync(cfg, good);
    }
    assert.equal(existsSync(marker), false, `race won after ${tries} status() calls`);
  });
});
