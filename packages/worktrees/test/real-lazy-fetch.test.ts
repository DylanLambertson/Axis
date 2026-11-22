// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// A partial clone whose OWN config chooses what a lazy fetch runs: no worktree-service git call may start it (security
// ticket "lazy fetch from daemon-side git", @axis/worktrees part). The same vectors as git-ops test/real-lazy-fetch.test.ts.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { createExecGitRunner } from '../src/index.js';
import { createHooksGuard, HardenedGit } from '../src/hardenedGit.js';

const GIT = ((): string | undefined => {
  const r = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : undefined;
})();
const version = ((): number[] => {
  const m = GIT === undefined ? null : /git version (\d+)\.(\d+)\.(\d+)/.exec(execFileSync(GIT, ['--version'], { encoding: 'utf8' }));
  return m === null ? [0, 0, 0] : [Number(m[1]), Number(m[2]), Number(m[3])];
})();
const atLeast = (v: number[]): boolean => {
  for (let i = 0; i < 3; i++) if ((version[i] ?? 0) !== (v[i] ?? 0)) return (version[i] ?? 0) > (v[i] ?? 0);
  return true;
};
const SKIP = process.platform === 'win32' ? 'POSIX shell fixture' : GIT === undefined ? 'no git' : !atLeast([2, 27, 0]) ? 'partial clone over file:// needs git 2.27' : false;
const PATH = process.env['PATH'] ?? '/usr/bin:/bin';

/** Each vector is a repository's own config that makes a lazy fetch run `evil` (writes MARKER). */
const VECTORS: Readonly<Record<string, (evil: string) => ReadonlyArray<readonly [string, string]>>> = {
  uploadpack: (e) => [['protocol.file.allow', 'always'], ['remote.origin.uploadpack', e]],
  vcsAlias: (e) => [['protocol.evil.allow', 'always'], ['remote.origin.vcs', 'evil'], ['alias.remote-evil', `!${e}`]],
  helperUrl: (e) => [['protocol.evil.allow', 'always'], ['remote.origin.url', 'evil::x'], ['alias.remote-evil', `!${e}`]],
  sshCommand: (e) => [['protocol.ssh.allow', 'always'], ['remote.origin.url', 'ssh://h.invalid/x'], ['core.sshCommand', e]],
  ext: (e) => [['protocol.ext.allow', 'always'], ['remote.origin.url', `ext::${e} %S x`]],
  slashAutocorrect: (e) => [['protocol./.allow', 'always'], ['remote.origin.vcs', '/'], ['help.autocorrect', '1'], ['alias.remote-a', `!${e}`]],
  emptyVcs: (e) => [['protocol.allow', 'always'], ['remote.origin.vcs', ''], ['alias.remote-', `!${e}`]],
};

const dirs: string[] = [];
process.on('exit', () => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = (p: string): string => {
  const d = realpathSync(mkdtempSync(path.join(os.tmpdir(), p)));
  dirs.push(d);
  return d;
};

type Filter = 'blob:none' | 'tree:0';

interface Hostile {
  readonly repo: string;
  readonly root: string;
  readonly env: Record<string, string>;
  /** a.txt at the first commit (missing in both clones) and the first commit's root tree (missing under tree:0). */
  readonly blob: string;
  readonly tree: string;
  readonly marker: string;
  fired(): boolean;
}

/**
 * A `--filter=<filter>` clone of a local bare repository with two commits (`base` is the first). blob:none lacks every
 * blob; tree:0 lacks every tree too. `idx` is a private index read from HEAD where that needs no fetch (blob:none), so
 * write-tree must check blobs the clone lacks.
 */
function hostile(filter: Filter, vector: string): Hostile {
  const g = GIT as string;
  const root = tmp('axis-wt-lazy-');
  const home = path.join(root, 'home');
  mkdirSync(home);
  const env = { PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1', LANG: 'C' };
  const run = (cwd: string, ...args: string[]): string => execFileSync(g, args, { cwd, env: { ...env, GIT_NO_LAZY_FETCH: '1' }, encoding: 'utf8' });
  run(root, 'init', '-q', '--bare', 'up.git');
  const src = path.join(root, 'src');
  run(root, 'init', '-q', src);
  for (const [k, v] of [['user.email', 'a@b'], ['user.name', 'a'], ['commit.gpgsign', 'false']] as const) run(src, 'config', k, v);
  mkdirSync(path.join(src, 'd'));
  writeFileSync(path.join(src, 'a.txt'), 'one\n');
  writeFileSync(path.join(src, 'd', 'x.txt'), 'x\n');
  run(src, 'add', '.');
  run(src, 'commit', '-qm', 'c1');
  writeFileSync(path.join(src, 'a.txt'), 'two\n');
  writeFileSync(path.join(src, 'd', 'x.txt'), 'y\n');
  run(src, 'commit', '-qam', 'c2');
  const blob = run(src, 'rev-parse', 'HEAD~1:a.txt').trim();
  const tree = run(src, 'rev-parse', 'HEAD~1^{tree}').trim();
  const up = path.join(root, 'up.git');
  run(src, 'push', '-q', up, 'HEAD:refs/heads/main');
  run(up, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  run(up, 'config', 'uploadpack.allowFilter', 'true');
  run(up, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  const repo = path.join(root, 'repo');
  execFileSync(g, ['-c', 'protocol.file.allow=always', 'clone', '-q', `--filter=${filter}`, '--no-checkout', `file://${up}`, repo], { cwd: root, env, stdio: 'ignore' });
  run(repo, 'branch', 'base', 'HEAD~1');
  if (filter === 'blob:none') execFileSync(g, ['read-tree', 'HEAD'], { cwd: repo, env: { ...env, GIT_NO_LAZY_FETCH: '1', GIT_INDEX_FILE: path.join(root, 'idx') } });
  const marker = path.join(root, 'MARKER');
  const evil = path.join(root, 'evil.sh');
  writeFileSync(evil, `#!/bin/sh\necho "$0 $*" >> '${marker}'\nexit 1\n`);
  chmodSync(evil, 0o755);
  for (const [k, v] of (VECTORS[vector] as (e: string) => ReadonlyArray<readonly [string, string]>)(evil)) run(repo, 'config', k, v);
  for (const id of filter === 'tree:0' ? [blob, tree] : [blob]) {
    assert.notEqual(spawnSync(g, ['cat-file', '-e', id], { cwd: repo, env: { ...env, GIT_NO_LAZY_FETCH: '1' } }).status, 0, `${id} is really missing`);
  }
  return { repo, root, env, blob, tree, marker, fired: () => existsSync(marker) };
}

interface Shape {
  readonly args: readonly string[];
  readonly input?: string;
  /** GIT_INDEX_FILE, under the fixture root. */
  readonly index?: string;
  /** The clones in which plain git runs the repository's program for this call (the control). */
  readonly fires: readonly Filter[];
  /**
   * The call does not need the object's content, so a git may skip the fetch: plain write-tree fetches on 2.53 but not
   * on 2.43 or 2.56, and for rev-list --objects, commit-tree, update-ref and a two-tree read-tree the fetch is an
   * implementation choice. A control that does not fire is reported, not failed; the call still runs through HardenedGit.
   */
  readonly versionDependent?: true;
}

/**
 * Every call shape in src/ that reads an object, in the form the manager sends it: ls-tree (dirty.ts, populate.ts,
 * snapshotHistory.ts, manager.ts), cat-file blob / --batch / --batch-check (manager.ts, populate.ts, snapshotHistory.ts,
 * snapshotRef.ts), rev-list --objects (snapshotHistory.ts), read-tree and write-tree into a private index and commit-tree
 * (snapshotRef.ts, populate.ts), update-ref to an object id (snapshotRef.ts; git checks the object exists), and read-tree
 * of two trees, which the read-tree shape admits though no caller sends it. The other shapes read refs, the index or the
 * config only and fetch nothing (probed:
 * rev-parse, symbolic-ref, show-ref, for-each-ref, merge-base, rev-list --count, ls-files, config, hash-object,
 * update-index --index-info, worktree add --no-checkout).
 */
const SHAPES = (h: Hostile): ReadonlyArray<Shape> => [
  { args: ['ls-tree', '-r', '-l', '-z', '--full-tree', 'HEAD'], fires: ['blob:none', 'tree:0'] },
  { args: ['ls-tree', '-r', '-z', '--full-tree', 'HEAD'], fires: ['tree:0'] },
  { args: ['ls-tree', '-r', '-t', '-z', '--end-of-options', 'base'], fires: ['tree:0'] },
  { args: ['ls-tree', '-z', '--end-of-options', 'base', '--', 'a.txt'], fires: ['tree:0'] },
  { args: ['cat-file', 'blob', h.blob], fires: ['blob:none', 'tree:0'] },
  { args: ['cat-file', '--batch'], input: `${h.blob}\n`, fires: ['blob:none', 'tree:0'] },
  { args: ['cat-file', '--batch-check'], input: `${h.blob}\n`, fires: ['blob:none', 'tree:0'] },
  { args: ['cat-file', '--batch-check'], input: `${h.tree}\n`, fires: ['tree:0'] },
  { args: ['rev-list', '--objects', '--end-of-options', 'base..HEAD'], fires: ['blob:none', 'tree:0'], versionDependent: true },
  { args: ['read-tree', 'HEAD'], index: 'idx-read', fires: ['tree:0'] },
  { args: ['write-tree'], index: 'idx', fires: ['blob:none'], versionDependent: true },
  { args: ['-c', 'user.name=a', '-c', 'user.email=a@b', 'commit-tree', h.tree, '-p', 'HEAD', '-m', 'm'], fires: ['tree:0'], versionDependent: true },
  { args: ['update-ref', 'refs/axis/probe-blob', h.blob, ZERO], fires: ['blob:none', 'tree:0'], versionDependent: true },
  { args: ['update-ref', 'refs/axis/probe-tree', h.tree, ZERO], fires: ['tree:0'], versionDependent: true },
  { args: ['read-tree', 'base', 'HEAD'], index: 'idx-two', fires: ['blob:none', 'tree:0'], versionDependent: true },
];

const ZERO = '0'.repeat(40);

/** The real git with one variable of the environment removed before it starts. */
function without(name: string): string {
  const p = path.join(tmp('axis-wt-gitwrap-'), 'git');
  writeFileSync(p, `#!/bin/sh\nunset ${name}\nexec '${GIT as string}' "$@"\n`);
  chmodSync(p, 0o755);
  return p;
}

// Each pin is the only protection in one variant, so dropping it makes a vector fire there:
// - as installed: every pin;
// - an old-git stand-in (git 2.24 to 2.43 have no GIT_NO_LAZY_FETCH): GIT_ALLOW_PROTOCOL=/ and help.autocorrect=0 alone;
// - with GIT_ALLOW_PROTOCOL removed (git 2.44 and later): GIT_NO_LAZY_FETCH alone.
const VARIANTS: ReadonlyArray<readonly [string, () => string, string | false]> = [
  ['git as installed', () => GIT as string, false],
  ['old-git stand-in (no GIT_NO_LAZY_FETCH)', () => without('GIT_NO_LAZY_FETCH'), false],
  ['GIT_NO_LAZY_FETCH alone (no GIT_ALLOW_PROTOCOL)', () => without('GIT_ALLOW_PROTOCOL'), atLeast([2, 44, 0]) ? false : 'GIT_NO_LAZY_FETCH needs git 2.44'],
];

for (const filter of ['blob:none', 'tree:0'] as const) {
  for (const vector of Object.keys(VECTORS)) {
    test(`no worktree-service git call runs a lazy-fetch program: ${filter}, ${vector}`, { skip: SKIP }, async (t) => {
      const h = hostile(filter, vector);
      const shapes = SHAPES(h);
      const env = (s: Shape): Record<string, string> => (s.index === undefined ? {} : { GIT_INDEX_FILE: path.join(h.root, s.index) });
      // Control: the same call with no Axis environment or options runs the repository's program. A call that needs the
      // object's content must fetch on every git; a version-dependent one that does not fetch on this git is noted.
      let fired = 0;
      for (const s of shapes.filter((x) => x.fires.includes(filter))) {
        rmSync(h.marker, { force: true });
        spawnSync(GIT as string, [...s.args], { cwd: h.repo, env: { ...h.env, ...env(s) }, input: s.input ?? '', timeout: 30_000 });
        if (h.fired()) fired++;
        else if (s.versionDependent === true) t.diagnostic(`git ${version.join('.')}: plain git ${s.args.join(' ')} does not lazy-fetch here; its control is not counted`);
        else assert.fail(`control: plain git ${s.args.join(' ')} runs the ${vector} program`);
      }
      assert.ok(fired > 0, 'at least one control fires, or the fixture is broken');
      rmSync(h.marker, { force: true });
      for (const [label, pick, needs] of VARIANTS) {
        await t.test(label, { skip: needs }, async () => {
          const git = new HardenedGit(createExecGitRunner({ gitPath: pick(), baseEnv: h.env, platform: 'linux' }), createHooksGuard('linux'), { timeoutMs: 30_000 });
          for (const s of shapes) {
            const ix = env(s);
            // No catch: a call HardenedGit refused would prove nothing, so each shape must really run (git may fail).
            await git.run(s.args, { cwd: h.repo, allowFailure: true, ...(s.input === undefined ? {} : { input: s.input }), ...(s.index === undefined ? {} : { extraEnv: ix }) });
            assert.equal(h.fired(), false, `${s.args.join(' ')} ran it: ${h.fired() ? readFileSync(h.marker, 'utf8') : ''}`);
          }
        });
      }
    });
  }
}

test('the exec runner pins GIT_NO_LAZY_FETCH=1 and GIT_ALLOW_PROTOCOL=/ over the base and the caller environment', { skip: process.platform === 'win32' ? 'POSIX env' : false }, async () => {
  const runner = createExecGitRunner({ gitPath: '/usr/bin/env', baseEnv: { PATH, GIT_NO_LAZY_FETCH: '0', GIT_ALLOW_PROTOCOL: 'file:ssh:ext' } });
  for (const extraEnv of [undefined, { GIT_NO_LAZY_FETCH: '0', GIT_ALLOW_PROTOCOL: 'ext' }]) {
    const out = (await runner.run([], { cwd: os.tmpdir(), ...(extraEnv === undefined ? {} : { extraEnv }) })).stdout;
    assert.match(out, /^GIT_NO_LAZY_FETCH=1$/m);
    assert.match(out, /^GIT_ALLOW_PROTOCOL=\/$/m);
    assert.equal(out.match(/^GIT_(NO_LAZY_FETCH|ALLOW_PROTOCOL)=/gm)?.length, 2);
  }
});

test('a caller variable cannot undo the pins: a real lazy fetch stays blocked', { skip: SKIP }, async () => {
  const h = hostile('blob:none', 'uploadpack');
  const undo = { GIT_NO_LAZY_FETCH: '0', GIT_ALLOW_PROTOCOL: 'file' };
  spawnSync(GIT as string, ['cat-file', 'blob', h.blob], { cwd: h.repo, env: { ...h.env, ...undo }, timeout: 30_000 });
  assert.equal(h.fired(), true, 'control: with those variables plain git runs the uploadpack');
  rmSync(h.marker, { force: true });
  // The runner directly (HardenedGit would refuse these names): its pins must still be the ones git sees.
  await createExecGitRunner({ gitPath: GIT as string, baseEnv: h.env, platform: 'linux' }).run(['cat-file', 'blob', h.blob], { cwd: h.repo, extraEnv: undo, timeoutMs: 30_000 });
  assert.equal(h.fired(), false, h.fired() ? readFileSync(h.marker, 'utf8') : '');
});

test('on Windows semantics every spelling of a pinned name is replaced by the one pin', { skip: process.platform === 'win32' ? 'POSIX env' : false }, async () => {
  const runner = createExecGitRunner({ gitPath: '/usr/bin/env', baseEnv: { PATH, git_no_lazy_fetch: '0' }, platform: 'win32' });
  const out = (await runner.run([], { cwd: os.tmpdir(), extraEnv: { git_allow_protocol: 'ext', Git_No_Lazy_Fetch: '0', GIT_ALLOW_PROTOCOL: 'file' } })).stdout;
  const pins = out.split('\n').filter((l) => /^git_(no_lazy_fetch|allow_protocol)=/i.test(l)).sort();
  assert.deepEqual(pins, ['GIT_ALLOW_PROTOCOL=/', 'GIT_NO_LAZY_FETCH=1']);
});

test('HardenedGit puts protocol.allow=never and help.autocorrect=0 before every command', async () => {
  const seen: string[][] = [];
  const git = new HardenedGit({ run: async (a: readonly string[]) => (seen.push([...a]), { code: 0, stdout: '', stderr: '', raw: Buffer.alloc(0) }) }, createHooksGuard('linux'));
  await git.run(['cat-file', '--batch'], { cwd: os.tmpdir(), input: 'x\n' });
  await git.run(['rev-parse', 'HEAD'], { cwd: os.tmpdir(), noOptionalLocks: true });
  for (const a of seen) {
    const sub = a.findIndex((x) => x === 'cat-file' || x === 'rev-parse');
    for (const pin of ['protocol.allow=never', 'help.autocorrect=0']) {
      const at = a.indexOf(pin);
      assert.ok(at > 0 && at < sub && a[at - 1] === '-c', `${pin} before the subcommand in ${a.join(' ')}`);
    }
  }
});
