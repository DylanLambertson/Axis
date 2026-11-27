// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

import assert from 'node:assert/strict';
import { linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { WorktreeError } from '../src/index.js';
import { writeRestoredEntry } from '../src/restore.js';

const FILE = { mode: '100644', type: 'blob', sha: '0'.repeat(40) } as const;
const denied = (e: unknown): boolean => e instanceof WorktreeError && e.code === 'E_POLICY_DENIED';
const temps = (dir: string): string[] => readdirSync(dir).filter((n) => n.includes('.axis-restore-'));

/** Makes a link, or reports (false) that this filesystem or account cannot, so the test can skip with a reason. */
function tryLink(make: () => void): boolean {
  try {
    make();
    return true;
  } catch (e) {
    if (['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP', 'UNKNOWN'].includes((e as NodeJS.ErrnoException).code ?? '')) return false;
    throw e;
  }
}

describe('restore writes through a descriptor and pins the directory identity', () => {
  let tmp: string;
  let wt: string;
  let outside: string;
  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'axis-restore-fd-')));
    wt = path.join(tmp, 'wt');
    outside = path.join(tmp, 'outside');
    mkdirSync(wt);
    mkdirSync(outside);
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('writes the content and the exec bit when nothing moves', async () => {
    await writeRestoredEntry(wt, 'd/f.sh', { ...FILE, mode: '100755' }, Buffer.from('echo\n'));
    assert.equal(readFileSync(path.join(wt, 'd', 'f.sh'), 'utf8'), 'echo\n');
    assert.deepEqual(temps(path.join(wt, 'd')), []);
  });

  it('never writes through a symlink planted at the temp path', async (t) => {
    const victim = path.join(outside, 'victim.txt');
    writeFileSync(victim, 'keep\n');
    let planted = true;
    await assert.rejects(
      writeRestoredEntry(wt, 'f.txt', FILE, Buffer.from('new\n'), {
        beforeCreate: (tmpPath) => {
          planted = tryLink(() => symlinkSync(victim, tmpPath));
        },
      }),
    ).catch((e: unknown) => {
      if (planted) throw e;
    });
    if (!planted) t.skip('symlinks are not available here');
    assert.equal(readFileSync(victim, 'utf8'), 'keep\n');
  });

  it('refuses when another file took the temp path (inode differs), and leaves that file alone', async () => {
    writeFileSync(path.join(wt, 'f.txt'), 'old\n');
    await assert.rejects(
      writeRestoredEntry(wt, 'f.txt', FILE, Buffer.from('restored\n'), {
        afterCreate: (tmpPath) => {
          renameSync(tmpPath, `${tmpPath}.keep`); // keeps the old inode alive, so the new file cannot reuse its number
          writeFileSync(tmpPath, 'attacker\n');
        },
      }),
      denied,
    );
    assert.equal(readFileSync(path.join(wt, 'f.txt'), 'utf8'), 'old\n', 'the attacker file was not renamed over the target');
    assert.equal(readFileSync(path.join(wt, temps(wt).find((n) => !n.endsWith('.keep')) as string), 'utf8'), 'attacker\n', 'and was not unlinked either');
  });

  it('refuses when the parent was replaced by another directory holding a link to the same temp file', async (t) => {
    let linked = true;
    await assert.rejects(
      writeRestoredEntry(wt, 'd/f.txt', FILE, Buffer.from('x\n'), {
        afterCreate: (tmpPath, dir) => {
          const moved = `${dir}.moved`;
          renameSync(dir, moved);
          mkdirSync(dir);
          linked = tryLink(() => linkSync(path.join(moved, path.basename(tmpPath)), tmpPath));
        },
      }),
      (e) => denied(e) || !linked,
    );
    if (!linked) t.skip('hard links are not available here');
    assert.equal(readdirSync(path.join(wt, 'd')).includes('f.txt'), false, 'nothing was renamed into the replacement directory');
  });

  it('refuses a parent swapped for a symlink before the open, and removes only its own temp file from where it landed', async (t) => {
    writeFileSync(path.join(outside, 'f.txt'), 'theirs\n');
    let swapped = true;
    await assert.rejects(
      writeRestoredEntry(wt, 'd/f.txt', FILE, Buffer.from('x\n'), {
        beforeCreate: (_tmp, dir) => {
          renameSync(dir, `${dir}.moved`);
          swapped = tryLink(() => symlinkSync(outside, dir));
        },
      }),
      (e) => denied(e) || !swapped,
    );
    if (!swapped) t.skip('symlinks are not available here');
    assert.equal(readFileSync(path.join(outside, 'f.txt'), 'utf8'), 'theirs\n');
    assert.deepEqual(temps(outside), [], 'our temp file was removed by the path it was opened under; nothing else was');
  });
});
