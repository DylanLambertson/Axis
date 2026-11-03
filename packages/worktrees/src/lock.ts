// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { WorktreeError } from './errors.js';

interface LockRecord {
  readonly pid: number;
  /** Start time of the holding process, epoch ms (best effort). */
  readonly processStart: number;
  readonly token: string;
}

export interface FileLockOptions {
  readonly timeoutMs?: number;
  readonly pollMs?: number;
  /** Test seams. */
  readonly pid?: number;
  readonly processStart?: number;
}

const START_TOLERANCE_MS = 5_000;

const OWN_START = Math.round(Date.now() - process.uptime() * 1000);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Start time of `pid` in epoch ms, or null when it cannot be determined. */
async function processStartOf(pid: number): Promise<number | null> {
  if (pid === process.pid) return OWN_START;
  if (process.platform === 'win32') return null;
  return new Promise((resolve) => {
    execFile('/bin/ps', ['-o', 'etimes=', '-p', String(pid)], { timeout: 2000 }, (err, stdout) => {
      const secs = Number(stdout.trim());
      resolve(err || !Number.isFinite(secs) ? null : Math.round(Date.now() - secs * 1000));
    });
  });
}

/** A lock is stale when its holder is gone or the pid now belongs to a different process. */
async function isStale(rec: LockRecord): Promise<boolean> {
  if (!alive(rec.pid)) return true;
  const start = await processStartOf(rec.pid);
  return start !== null && Math.abs(start - rec.processStart) > START_TOLERANCE_MS;
}

function parse(text: string): LockRecord | null {
  try {
    const v = JSON.parse(text) as Partial<LockRecord>;
    return typeof v.pid === 'number' && typeof v.processStart === 'number' && typeof v.token === 'string'
      ? (v as LockRecord)
      : null;
  } catch {
    return null;
  }
}

/**
 * Cross-process lock: an O_EXCL lockfile holding pid and process start time.
 * A lock whose holder has died, or whose pid was reused by a process with a
 * different start time, is reclaimed. Returns the release function.
 */
export async function acquireFileLock(file: string, opts: FileLockOptions = {}): Promise<() => Promise<void>> {
  const deadline = Date.now() + (opts.timeoutMs ?? 15_000);
  const record: LockRecord = {
    pid: opts.pid ?? process.pid,
    processStart: opts.processStart ?? OWN_START,
    token: randomBytes(8).toString('hex'),
  };
  const body = JSON.stringify(record);
  for (;;) {
    try {
      const fh = await fs.open(file, 'wx', 0o600);
      try {
        await fh.writeFile(body);
      } finally {
        await fh.close();
      }
      return async () => {
        // only remove a lock that is still ours
        const cur = await fs.readFile(file, 'utf8').catch(() => null);
        if (cur === body) await fs.rm(file, { force: true });
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    const text = await fs.readFile(file, 'utf8').catch(() => null);
    if (text !== null) {
      const rec = parse(text);
      // an unparsable file may be a holder mid-write: only reclaim it once it has aged
      const aged = rec !== null || Date.now() - ((await fs.stat(file).catch(() => null))?.mtimeMs ?? 0) > 2_000;
      if (aged && (rec === null || (await isStale(rec))) && (await fs.readFile(file, 'utf8').catch(() => null)) === text) {
        await fs.rm(file, { force: true });
        continue;
      }
    }
    if (Date.now() >= deadline) {
      throw new WorktreeError('E_CONFLICT', 'another Axis operation holds the workspace lock', { reason: 'locked' });
    }
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 25));
  }
}
