// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// PV-X1b (docs/design/pty-exec-node.md §6.1 and §6.2): programs, the PTY-5 environment and the scratch directory main hands the pty
// process. Real files in a private temporary directory (POSIX: the pty process has no exec on Windows).
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PTY_ENV_GH, PTY_ENV_GIT, PTY_ENV_SCRATCH, readPtyExecConfig } from "@axis/pty-process/config";
import { checkedHandover, createPtySpawn, newPtyScratch, preparePtyScratchRoot, ptyEnvironment, ptyScratchRoot, removePtyScratch, resolvePtyPrograms, type PtyForkedChild, type PtyLaunchEvent } from "../src/main/pty-launch.js";
import { PtySupervisor } from "../src/main/pty-supervisor.js";
import { DAEMON_ENV_ALLOW } from "../src/supervisor.js";

const posix = process.platform !== "win32";

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
  const env = ptyEnvironment(source, {});
  for (const name of Object.keys(env)) assert.ok((DAEMON_ENV_ALLOW as readonly string[]).includes(name) || name === "SSH_AUTH_SOCK", `${name} passed`);
  assert.deepEqual(env, { PATH: "/usr/bin", HOME: "/home/u", LANG: "C", SSH_AUTH_SOCK: "/tmp/agent.sock" });
  assert.ok(!Object.keys(env).some((n) => n.startsWith("AXIS_")), "an AXIS_* name of main's own environment never passes, the hand-over names included");
  const handed = ptyEnvironment(source, { gitPath: "/usr/bin/git", scratch: "/s" });
  assert.deepEqual(Object.keys(handed).filter((n) => n.startsWith("AXIS_")).sort(), [PTY_ENV_GIT, PTY_ENV_SCRATCH]);
  assert.equal(handed[PTY_ENV_GIT], "/usr/bin/git", "main's value, never the source's");
  assert.equal(handed[PTY_ENV_GH], undefined);
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

test("scratch root: a symlink in place of the root is refused", { skip: !posix }, (t) => {
  const box = sandbox(t);
  const target = join(box, "target");
  mkdirSync(target, { mode: 0o700 });
  symlinkSync(target, join(box, "pty-scratch"));
  assert.equal(preparePtyScratchRoot(join(box, "pty-scratch")), false);
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
  assert.deepEqual(checkedHandover({ gitPath: loose, ghPath: gh }, scratch, (e) => events.push(e)), { ghPath: gh });
  assert.deepEqual(checkedHandover({ gitPath: git, ghPath: gh }, undefined, (e) => events.push(e)), { ghPath: gh }, "no scratch: git off");
  assert.deepEqual(events, ["gh_path_refused", "git_path_refused", "scratch_refused"]);
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
  const failing = createPtySpawn({ platform: "linux", shellEnv: {}, programs: { gitPath: git }, scratchRoot: root, fork: () => { throw new Error("fork failed"); } });
  assert.throws(() => failing());
  assert.deepEqual(readdirSync(root), []);
  const envs: Record<string, string>[] = [];
  const noGit = createPtySpawn({ platform: "linux", shellEnv: {}, programs: {}, scratchRoot: root, fork: (env) => (envs.push(env), { kill: () => undefined, postMessage: () => undefined, onExit: () => () => undefined }) });
  noGit();
  assert.deepEqual(readdirSync(root), []);
  assert.equal(envs[0]![PTY_ENV_SCRATCH], undefined);
  const win = createPtySpawn({ platform: "win32", shellEnv: {}, programs: { gitPath: git }, scratchRoot: root, fork: (env) => (envs.push(env), { kill: () => undefined, postMessage: () => undefined, onExit: () => () => undefined }) });
  win();
  assert.deepEqual(Object.keys(envs[1]!).filter((n) => n.startsWith("AXIS_")), [], "Windows: no hand-over names");
});
