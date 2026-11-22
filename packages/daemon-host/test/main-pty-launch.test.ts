// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// PV-X1b (docs/design/pty-exec-node.md §6.1 and §6.2): programs, the PTY-5 environment and the scratch directory main hands the pty
// process. Real files in a private temporary directory (POSIX: the pty process has no exec on Windows).
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PTY_ENV_GH, PTY_ENV_GIT, PTY_ENV_SCRATCH, readPtyExecConfig } from "@axis/pty-process/config";
import { checkedHandover, createPtySpawn, newPtyScratch, preparePtyScratchRoot, processAlive, ptyEnvironment, ptyScratchRoot, removePtyScratch, resolvePtyPrograms, trustedPathValue, type PtyForkedChild, type PtyLaunchEvent } from "../src/main/pty-launch.js";
import { PtySupervisor } from "../src/main/pty-supervisor.js";
import { DAEMON_ENV_ALLOW } from "../src/supervisor.js";

const posix = process.platform !== "win32";
const NO_RULE = { platform: "linux" as const, excludeDirs: [] };

function sandbox(t: { after: (fn: () => void) => void }): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "axis-pty-launch-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function program(dir: string, name: string, mode = 0o755): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, "#!/bin/sh\nexit 0\n");
  chmodSync(p, mode);
  return p;
}

test("PTY-5: the environment keeps only the daemon's allow-list, SSH_AUTH_SOCK and the hand-over names main sets", () => {
  const source: Record<string, string> = {
    PATH: "/usr/bin", HOME: "/home/u", LANG: "C", SSH_AUTH_SOCK: "/tmp/agent.sock",
    AXIS_VAULT_KEY: "v", AXIS_DAEMON_ANCHOR: "a", AXIS_PTY_GIT: "/evil/git", AXIS_PTY_SCRATCH: "/evil", AXIS_PTY_GH: "/evil/gh",
    ANTHROPIC_API_KEY: "k", GH_TOKEN: "t", AWS_SECRET_ACCESS_KEY: "s", NODE_OPTIONS: "--require /evil.js", NODE_PATH: "/evil",
    ELECTRON_RUN_AS_NODE: "1", VSCODE_PID: "1", LD_PRELOAD: "/evil.so", DYLD_INSERT_LIBRARIES: "/evil.dylib", GIT_DIR: "/evil",
  };
  const env = ptyEnvironment(source, {}, NO_RULE);
  for (const name of Object.keys(env)) assert.ok((DAEMON_ENV_ALLOW as readonly string[]).includes(name) || name === "SSH_AUTH_SOCK", `${name} passed`);
  assert.deepEqual(env, { PATH: "/usr/bin", HOME: "/home/u", LANG: "C", SSH_AUTH_SOCK: "/tmp/agent.sock" });
  assert.ok(!Object.keys(env).some((n) => n.startsWith("AXIS_")), "an AXIS_* name of main's own environment never passes, the hand-over names included");
  const handed = ptyEnvironment(source, { gitPath: "/usr/bin/git", scratch: "/s" }, NO_RULE);
  assert.deepEqual(Object.keys(handed).filter((n) => n.startsWith("AXIS_")).sort(), [PTY_ENV_GIT, PTY_ENV_SCRATCH]);
  assert.equal(handed[PTY_ENV_GIT], "/usr/bin/git", "main's value, never the source's");
  assert.equal(handed[PTY_ENV_GH], undefined);
});

test("PATH keeps only plain absolute entries outside the Axis roots, by spelling or real path (SF-1, as withTrustedPath)", { skip: !posix }, (t) => {
  const box = sandbox(t);
  const worktrees = join(box, "Axis", "worktrees");
  mkdirSync(join(worktrees, "ws", "bin"), { recursive: true });
  const into = join(box, "into-worktree");
  symlinkSync(join(worktrees, "ws", "bin"), into);
  const rule = { platform: "linux" as const, excludeDirs: [join(box, "Axis"), worktrees] };
  const path = ["/usr/bin", ".", "node_modules/.bin", "", join(worktrees, "ws", "bin"), into, join(box, "Axis", "daemon"), "/bin"].join(":");
  assert.equal(trustedPathValue(path, rule), "/usr/bin:/bin");
  assert.equal(ptyEnvironment({ PATH: path, HOME: "/h" }, {}, rule).PATH, "/usr/bin:/bin", "the pty process gets the filtered PATH");
  assert.equal(trustedPathValue("", rule), "");
  const win = ptyEnvironment({ Path: "C:\\Windows;.;relative\\bin;C:\\Tools" } as Record<string, string>, {}, { platform: "win32", excludeDirs: [] });
  assert.deepEqual(Object.entries(win).filter(([k]) => k.toUpperCase() === "PATH"), [], "Windows: a differently cased Path is not on the allow-list at all");
  assert.equal(trustedPathValue("C:\\Windows;.;relative\\bin;C:\\Tools", { platform: "win32", excludeDirs: ["C:\\Tools"] }), "C:\\Windows");
});

test("programs: found on PATH as real paths; a directory inside an excluded root never wins; not found is left out", { skip: !posix }, (t) => {
  const box = sandbox(t);
  const worktrees = join(box, "Axis", "worktrees");
  const planted = program(join(worktrees, "ws", "bin"), "git");
  const realBin = join(box, "real", "bin");
  const git = program(realBin, "git");
  const linkDir = join(box, "links");
  mkdirSync(linkDir);
  symlinkSync(git, join(linkDir, "git"));
  const env = { PATH: [join(worktrees, "ws", "bin"), linkDir].join(":") };
  const found = resolvePtyPrograms(env, "linux", [worktrees]);
  assert.deepEqual(found, { gitPath: git }, "the symlink is resolved and the planted git is skipped; no gh on PATH");
  assert.notEqual(found.gitPath, planted);
  assert.deepEqual(resolvePtyPrograms({ PATH: join(box, "nothing") }, "linux", []), {});
  assert.deepEqual(resolvePtyPrograms(env, "win32", []), {}, "Windows: no exec, so no programs");
});

test("scratch root: made 0700, not listable by others, every leftover of an earlier run removed", { skip: !posix }, (t) => {
  const box = sandbox(t);
  const root = ptyScratchRoot(join(box, "Axis", "daemon"));
  assert.equal(root, join(box, "Axis", "pty-scratch"), "next to the daemon's data directory, never inside it");
  mkdirSync(join(root, "run-old", "deep"), { recursive: true });
  writeFileSync(join(root, "run-old", "deep", "f"), "x");
  writeFileSync(join(root, "stray"), "x");
  chmodSync(root, 0o755);
  assert.ok(preparePtyScratchRoot(root));
  assert.equal(lstatSync(root).mode & 0o777, 0o700);
  assert.deepEqual(readdirSync(root), [], "leftovers swept: nothing accumulates across crashes of main");
  const run = newPtyScratch(root)!;
  assert.equal(lstatSync(run).mode & 0o777, 0o700);
  assert.equal(typeof readPtyExecConfig({ [PTY_ENV_SCRATCH]: run }), "object", "the entry accepts it as a scratch directory");
  const elsewhere = join(box, "run-elsewhere");
  const strayInRoot = join(root, "stray-not-run");
  const nested = join(run, "run-nested");
  for (const d of [elsewhere, strayInRoot, nested]) mkdirSync(d, { recursive: true });
  removePtyScratch(elsewhere, root);
  removePtyScratch(strayInRoot, root);
  removePtyScratch(nested, root);
  assert.ok(existsSync(elsewhere) && existsSync(strayInRoot) && existsSync(nested), "only a direct run-* child of the root is ever removed");
  removePtyScratch(run, root);
  assert.equal(existsSync(run), false);
});

test("scratch root: a symlink in place of the root is refused and nothing in its target is removed (SF-2)", { skip: !posix }, (t) => {
  const box = sandbox(t);
  const target = join(box, "target");
  mkdirSync(target, { mode: 0o700 });
  writeFileSync(join(target, "canary"), "keep");
  mkdirSync(join(target, "run-1-x"));
  symlinkSync(target, join(box, "pty-scratch"));
  assert.equal(preparePtyScratchRoot(join(box, "pty-scratch")), false);
  assert.ok(existsSync(join(target, "canary")) && existsSync(join(target, "run-1-x")), "the sweep never follows the symlink");
});

test("scratch root: the sweep keeps the live run directories of another main process and removes the rest (NIT-5)", { skip: !posix }, (t) => {
  const box = sandbox(t);
  const root = join(box, "pty-scratch");
  for (const name of ["run-100-live", "run-200-dead", "run-300-mine", "run-bad", "other", "run-0-x", "run-1-x", "run-99999999999999999999-x"]) mkdirSync(join(root, name), { recursive: true });
  assert.ok(preparePtyScratchRoot(root, 300, (pid) => pid !== 200));
  assert.deepEqual(readdirSync(root).sort(), ["run-100-live"], "another instance's live scratch survives; dead, own (a reused pid), pid 0, pid 1, an unsafe pid and stray entries go");
  const mine = newPtyScratch(root, 300)!;
  assert.match(mine.slice(root.length + 1), /^run-300-/);
});

test("the hand-over is checked with the entry's own rule: a refused program is dropped with its closed code, the rest kept", { skip: !posix }, (t) => {
  const box = sandbox(t);
  const git = program(join(box, "bin"), "git");
  const gh = program(join(box, "bin"), "gh");
  const loose = program(join(box, "loose"), "gh", 0o775);
  const root = join(box, "pty-scratch");
  assert.ok(preparePtyScratchRoot(root));
  const scratch = newPtyScratch(root)!;
  const events: PtyLaunchEvent[] = [];
  assert.deepEqual(checkedHandover({ gitPath: git, ghPath: gh }, scratch, (e) => events.push(e)), { gitPath: git, ghPath: gh, scratch });
  assert.deepEqual(checkedHandover({ gitPath: git, ghPath: loose }, scratch, (e) => events.push(e)), { gitPath: git, scratch });
  assert.deepEqual(checkedHandover({ gitPath: loose, ghPath: gh }, scratch, (e) => events.push(e)), { ghPath: gh, scratch }, "gh keeps the scratch it needs");
  assert.deepEqual(checkedHandover({ ghPath: gh }, scratch, (e) => events.push(e)), { ghPath: gh, scratch }, "gh alone gets a scratch");
  assert.deepEqual(checkedHandover({ gitPath: loose, ghPath: loose }, scratch, (e) => events.push(e)), {}, "no program left: no scratch either");
  assert.deepEqual(checkedHandover({ gitPath: git, ghPath: gh }, undefined, (e) => events.push(e)), {}, "no scratch: git and gh off");
  assert.deepEqual(checkedHandover({}, scratch, (e) => events.push(e)), {}, "no program: no scratch");
  assert.deepEqual(events, ["gh_path_refused", "git_path_refused", "git_path_refused", "gh_path_refused", "scratch_refused"]);
});

test("each spawn gets its own 0700 scratch, removed when that process exits; a crash restart leaves nothing behind", { skip: !posix }, (t) => {
  const box = sandbox(t);
  const git = program(join(box, "bin"), "git");
  const root = join(box, "pty-scratch");
  assert.ok(preparePtyScratchRoot(root));
  const forks: { env: Record<string, string>; exit: (code: number | null) => void }[] = [];
  const spawn = createPtySpawn({
    platform: "linux",
    shellEnv: { PATH: "/usr/bin", AXIS_VAULT_KEY: "x" },
    programs: { gitPath: git },
    excludeDirs: [],
    scratchRoot: root,
    fork: (env): PtyForkedChild => {
      let handler: ((code: number | null) => void) | undefined;
      forks.push({ env, exit: (code) => handler?.(code) });
      return { kill: () => undefined, postMessage: () => undefined, onExit: (h) => ((handler = h), () => undefined) };
    },
  });
  let now = 0;
  const timers: { fn: () => void; at: number }[] = [];
  const sup = new PtySupervisor({ spawn, timers: { set: (fn, ms) => timers.push({ fn, at: now + ms }), clear: () => undefined }, now: () => now });
  sup.start();
  const first = forks[0]!.env[PTY_ENV_SCRATCH]!;
  assert.equal(lstatSync(first).mode & 0o777, 0o700);
  assert.equal(forks[0]!.env.AXIS_VAULT_KEY, undefined);
  forks[0]!.exit(1);
  assert.equal(existsSync(first), false, "removed at the crash");
  now += 1000;
  timers.shift()!.fn();
  const second = forks[1]!.env[PTY_ENV_SCRATCH]!;
  assert.notEqual(second, first);
  assert.deepEqual(readdirSync(root), [second.slice(root.length + 1)], "exactly one scratch exists: no accumulation");
  forks[1]!.exit(0);
  assert.deepEqual(readdirSync(root), []);
});

test("a fork that throws removes the scratch it made; without git no scratch is made at all", { skip: !posix }, (t) => {
  const box = sandbox(t);
  const git = program(join(box, "bin"), "git");
  const root = join(box, "pty-scratch");
  assert.ok(preparePtyScratchRoot(root));
  const failing = createPtySpawn({ platform: "linux", shellEnv: {}, programs: { gitPath: git }, excludeDirs: [], scratchRoot: root, fork: () => { throw new Error("fork failed"); } });
  assert.throws(() => failing());
  assert.deepEqual(readdirSync(root), []);
  const envs: Record<string, string>[] = [];
  const noGit = createPtySpawn({ platform: "linux", shellEnv: {}, programs: {}, excludeDirs: [], scratchRoot: root, fork: (env) => (envs.push(env), { kill: () => undefined, postMessage: () => undefined, onExit: () => () => undefined }) });
  noGit();
  assert.deepEqual(readdirSync(root), []);
  assert.equal(envs[0]![PTY_ENV_SCRATCH], undefined);
  const win = createPtySpawn({ platform: "win32", shellEnv: {}, programs: { gitPath: git }, excludeDirs: [], scratchRoot: root, fork: (env) => (envs.push(env), { kill: () => undefined, postMessage: () => undefined, onExit: () => () => undefined }) });
  win();
  assert.deepEqual(Object.keys(envs[1]!).filter((n) => n.startsWith("AXIS_")), [], "Windows: no hand-over names");
});

test("liveness: a process of another user (EPERM) is alive; no such process (ESRCH) is not", () => {
  const throwing = (code: string) => () => {
    throw Object.assign(new Error(code), { code });
  };
  assert.equal(processAlive(4242, throwing("EPERM")), true);
  assert.equal(processAlive(4242, throwing("ESRCH")), false);
  assert.equal(processAlive(4242, () => true), true);
  assert.equal(processAlive(process.pid), true, "the default probes this very process");
});

test("createPtySpawn filters the forked process's PATH against the excluded roots it is given (SF-A)", { skip: !posix }, (t) => {
  const box = sandbox(t);
  const worktrees = join(box, "Axis", "worktrees");
  mkdirSync(join(worktrees, "ws", "bin"), { recursive: true });
  const envs: Record<string, string>[] = [];
  const spawn = createPtySpawn({
    platform: "linux",
    shellEnv: { PATH: ["/usr/bin", join(worktrees, "ws", "bin"), ".", "/bin"].join(":") },
    programs: {},
    excludeDirs: [worktrees],
    scratchRoot: undefined,
    fork: (env) => (envs.push(env), { kill: () => undefined, postMessage: () => undefined, onExit: () => () => undefined }),
  });
  spawn();
  assert.equal(envs[0]!.PATH, "/usr/bin:/bin", "the worktree entry and the relative entry never reach the pty process");
});
