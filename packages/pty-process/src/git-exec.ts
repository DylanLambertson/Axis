// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The pty service's `exec`, `scratch-*` and `hook` messages (docs/design/daemon-host-hooks.md §4). Every path in a scratch
// attempt is derived from the service's own root and the validated attempt id; no path comes from a message.
import { createHash } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { boundPrefix, checkExecArgv, filterPins, OBJECT_ID, parseGitVersion, plainPrefix, atLeast, type GitVersion } from "./exec-argv.js";
import { buildExecEnv, buildHookEnv, pty5Clean, type BoundRedirect, type ConfigIsolation } from "./exec-env.js";
import { ATTEMPT_ID, type ControlReply, type ControlRequest, type ExecReply } from "./messages.js";
import { hasNul, isAbsolutePath } from "./paths.js";
import { parseCatFileBatch, parseLsTree, planManifest, SCRATCH_LIMITS, verifyScratchTree, writeScratchTree, type Manifest } from "./scratch-tree.js";
import type { Clock, ExecChild, ExecFn, ExecOutcome } from "./ports.js";

export interface GitExecConfig {
  /** Starts a bounded command in its own process group. */
  readonly exec: ExecFn;
  /** The one absolute git the pty process uses; `argv[0]` of every exec must equal it. Set at start, never from a message. */
  readonly gitPath: string;
  /** git-ops' hooks-off path (`/dev/null`, or a verified-empty directory on Windows). Never empty. */
  readonly hooksOff: string;
  /** An existing private directory; the service owns `<scratchParent>/hook-scratch` and sweeps it at start and on close. */
  readonly scratchParent: string;
  /** The pty process's own startup environment (PTY-5 clean); the exec environment starts from it. */
  readonly baseEnv: Readonly<Record<string, string | undefined>>;
  /** Execs running at once. Default 8. */
  readonly maxExecs?: number;
  /** Bound on each internal git call of a scratch step. Default 120 s. */
  readonly stepTimeoutMs?: number;
}

type ExecMsg = Extract<ControlRequest, { t: "exec" }>;
type HookMsg = Extract<ControlRequest, { t: "hook" }>;
type ScratchMsg = Extract<ControlRequest, { t: "scratch-begin" | "scratch-verify" | "scratch-end" }>;
type SpawnFailCode = Extract<ControlReply, { t: "spawn-failed" }>["code"];

interface Attempt {
  readonly id: string;
  readonly dir: string;
  readonly gitDir: string;
  readonly worktree: string;
  readonly tree: string;
  manifest: Manifest | undefined;
  sizes: Map<string, number>;
  message: Buffer | undefined;
  ready: boolean;
}

export interface GitExec {
  handle(m: ExecMsg | ScratchMsg): void;
  /** Validates a hook and returns what to spawn, or a refusal code. The caller spawns it as a terminal. */
  prepareHook(m: HookMsg): { argv: string[]; cwd: string; env: Record<string, string> } | { code: SpawnFailCode };
  /** The control channel closed or the service is disposed: kill every exec and remove every attempt. */
  closeAll(): void;
}

export const MAX_ATTEMPTS = 2;
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const HOOK_MAX_BYTES = 64 * 1024 * 1024;

/** Removes a directory tree without following links; a directory a hook made read-only is opened up first. */
function removeTree(p: string): void {
  try {
    rmSync(p, { recursive: true, force: true });
    return;
  } catch {
    /* fall through */
  }
  const open = (d: string): void => {
    let st;
    try {
      st = lstatSync(d);
    } catch {
      return;
    }
    if (!st.isDirectory()) return;
    try {
      chmodSync(d, 0o700);
      for (const n of readdirSync(d)) open(join(d, n));
    } catch {
      /* best effort */
    }
  };
  open(p);
  rmSync(p, { recursive: true, force: true });
}

const within = (root: string, p: string): boolean => {
  const r = relative(root, p);
  return r !== "" && !r.startsWith("..") && !r.startsWith(sep) && resolve(root, r) === p;
};

export function createGitExec(cfg: GitExecConfig, clock: Clock, platform: NodeJS.Platform, send: (m: ExecReply) => void): GitExec {
  if (!isAbsolutePath(cfg.gitPath, platform) || cfg.hooksOff === "" || hasNul(cfg.hooksOff) || !isAbsolutePath(cfg.scratchParent, platform)) {
    throw new Error("the git exec configuration needs an absolute git path, a hooks-off path and an absolute scratch parent");
  }
  const maxExecs = cfg.maxExecs ?? 8;
  const stepMs = cfg.stepTimeoutMs ?? 120_000;
  const root = join(cfg.scratchParent, "hook-scratch");
  const emptyDir = join(root, ".empty");
  const emptyFile = join(emptyDir, "config");
  // Swept at start: nothing a previous process left can be reused.
  removeTree(root);
  mkdirSync(root, { mode: 0o700 });
  chmodSync(root, 0o700);
  mkdirSync(emptyDir, { mode: 0o700 });
  writeFileSync(emptyFile, "", { mode: 0o600, flag: "wx" });

  const running = new Set<ExecChild>();
  const attempts = new Map<string, Attempt>();
  let version: GitVersion | undefined;
  let generation = 0;
  let inflight = 0;

  /** Runs one command under a timeout on the injected clock. Never throws. */
  const run = (argv: readonly string[], cwd: string, env: Record<string, string>, stdin: Uint8Array | undefined, ms: number, maxOutput: number): Promise<ExecOutcome | "timeout" | "spawn_failed"> => {
    let child: ExecChild;
    try {
      child = cfg.exec({ argv, cwd, env, maxOutput, ...(stdin === undefined ? {} : { stdin }) });
    } catch {
      return Promise.resolve("spawn_failed");
    }
    running.add(child);
    return new Promise((res) => {
      let done = false;
      const timer = clock.setTimeout(() => {
        if (done) return;
        done = true;
        running.delete(child);
        try {
          child.kill();
        } catch {
          /* already gone */
        }
        res("timeout");
      }, ms);
      child.done.then(
        (o) => {
          if (done) return;
          done = true;
          clock.clearTimeout(timer);
          running.delete(child);
          // The cap holds even if the exec function kept more.
          const cut = (b: Uint8Array): Uint8Array => (b.length > maxOutput ? b.subarray(0, maxOutput) : b);
          res({ ...o, stdout: cut(o.stdout), stderr: cut(o.stderr), truncated: o.truncated || o.stdout.length > maxOutput || o.stderr.length > maxOutput });
        },
        () => {
          if (done) return;
          done = true;
          clock.clearTimeout(timer);
          running.delete(child);
          res("spawn_failed");
        },
      );
    });
  };

  const detectVersion = async (): Promise<GitVersion | undefined> => {
    if (version !== undefined) return version;
    const env = buildExecEnv(cfg.baseEnv, {}, undefined);
    if (env === undefined) return undefined;
    const r = await run([cfg.gitPath, "version"], cfg.scratchParent, env, undefined, stepMs, 4096);
    if (typeof r !== "string" && r.code === 0) version = parseGitVersion(Buffer.from(r.stdout).toString("utf8"));
    return version;
  };

  const isolation = (v: GitVersion | undefined): ConfigIsolation | undefined =>
    atLeast(v, [2, 32, 0]) ? { kind: "env", emptyFile } : atLeast(v, [2, 24, 0]) ? { kind: "home", emptyDir } : undefined;

  const redirectFor = (a: Attempt, index: 1 | 2): BoundRedirect => ({ gitDir: a.gitDir, workTree: join(a.dir, "tree"), indexFile: join(a.dir, `index${index}`) });

  /** A bound git call the service makes itself (fill and verify). */
  const boundRun = async (a: Attempt, index: 1 | 2, args: readonly string[], stdin?: Uint8Array, maxOutput = 16 * 1024 * 1024): Promise<ExecOutcome | undefined> => {
    const iso = isolation(await detectVersion());
    if (iso === undefined) return undefined;
    const redirect = redirectFor(a, index);
    const env = buildExecEnv(cfg.baseEnv, {}, { redirect, isolation: iso });
    if (env === undefined) return undefined;
    const argv = await pinned(boundPrefix(cfg.hooksOff), args, redirect.workTree, env);
    if (argv === undefined) return undefined;
    const r = await run(argv, redirect.workTree, env, stdin, stepMs, maxOutput);
    return typeof r === "string" ? undefined : r;
  };

  /**
   * `[git, ...prefix, ...filter pins, ...args]`. The filter pins come from a config read with the same prefix and
   * environment just before (config reads start nothing, so `config` itself gets none and the pinless read stays exact).
   */
  const pinned = async (prefix: readonly string[], args: readonly string[], cwd: string, env: Record<string, string>): Promise<string[] | undefined> => {
    if (args[0] === "config") return [cfg.gitPath, ...prefix, ...args];
    const gen = generation;
    const r = await run([cfg.gitPath, ...prefix, "config", "--null", "--name-only", "--get-regexp", "^filter\\."], cwd, env, undefined, stepMs, 1 << 20);
    // The channel closed (or the service was disposed) during the read: nothing may start after closeAll.
    if (gen !== generation || typeof r === "string" || r.truncated || (r.code !== 0 && r.code !== 1)) return undefined;
    const pins = r.code === 1 ? [] : filterPins(Buffer.from(r.stdout).toString("utf8"));
    return pins === undefined ? undefined : [cfg.gitPath, ...prefix, ...pins, ...args];
  };

  const gitDirOk = (p: string): boolean => {
    if (!isAbsolutePath(p, platform) || hasNul(p)) return false;
    try {
      if (!lstatSync(p).isDirectory()) return false;
      lstatSync(join(p, "HEAD"));
    } catch {
      return false;
    }
    for (const n of ["commondir", "objects"]) {
      try {
        lstatSync(join(p, n));
        return true;
      } catch {
        /* try the next */
      }
    }
    return false;
  };

  const handleExec = async (m: ExecMsg): Promise<void> => {
    const gen = generation;
    // After a close the reply would reach the next control channel, which never sent this request: say nothing.
    const fail = (code: Extract<ExecReply, { t: "exec-failed" }>["code"]): void => void (gen === generation && send({ t: "exec-failed", req: m.req, code }));
    // The env re-check runs for plain and bound calls alike: only allow-listed names, never a redirector.
    if (buildExecEnv({}, m.env, undefined) === undefined) return fail("env_denied");
    if ((m.repo === undefined) === (m.bind === undefined)) return fail("bad_bind");
    if (!isAbsolutePath(m.cwd, platform) || hasNul(m.cwd)) return fail("bad_argv");
    // Reserved at entry, so handlers still awaiting their reads count too.
    if (inflight >= maxExecs) return fail("capacity");
    inflight++;
    try {
      await execReserved(m, gen, fail);
    } finally {
      inflight--;
    }
  };

  const execReserved = async (m: ExecMsg, gen: number, fail: (code: Extract<ExecReply, { t: "exec-failed" }>["code"]) => void): Promise<void> => {
    const v = await detectVersion();
    if (gen !== generation) return;
    const verdict = checkExecArgv(m.argv, { gitPath: cfg.gitPath, bound: m.bind !== undefined, version: v });
    if (!verdict.ok) return fail("bad_argv");
    let prefix: string[];
    let env: Record<string, string> | undefined;
    let cwd = m.cwd;
    if (m.bind !== undefined) {
      const a = attempts.get(m.bind.attempt);
      const iso = isolation(v);
      if (a === undefined || !a.ready || a.gitDir !== m.bind.gitDir) return fail("bad_bind");
      if (iso === undefined) return fail("spawn_failed");
      const redirect = redirectFor(a, m.bind.index);
      env = buildExecEnv(cfg.baseEnv, m.env, { redirect, isolation: iso });
      prefix = boundPrefix(cfg.hooksOff);
      cwd = redirect.workTree;
    } else {
      const repo = m.repo as { gitDir: string; workTree: string };
      if (![repo.gitDir, repo.workTree].every((p) => isAbsolutePath(p, platform) && !hasNul(p))) return fail("bad_bind");
      env = buildExecEnv(cfg.baseEnv, m.env, undefined);
      prefix = plainPrefix(repo, cfg.hooksOff, verdict.sub, verdict.pinless);
    }
    if (env === undefined) return fail("env_denied");
    const argv = await pinned(prefix, [verdict.sub, ...verdict.rest], cwd, env);
    if (gen !== generation) return;
    if (argv === undefined) return fail("spawn_failed");
    const r = await run(argv, cwd, env, m.stdin === undefined ? undefined : Buffer.from(m.stdin, "utf8"), m.timeoutMs, m.maxOutput);
    if (r === "timeout" || r === "spawn_failed") return fail(r);
    if (gen !== generation) return;
    const text = (b: Uint8Array): string => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString("utf8");
    send({ t: "exec-result", req: m.req, code: r.code, signal: r.signal, stdout: text(r.stdout), stderr: text(r.stderr), truncated: r.truncated });
  };

  const dropAttempt = (id: string): void => {
    const a = attempts.get(id);
    if (a === undefined) return;
    attempts.delete(id);
    removeTree(a.dir);
  };

  const begin = async (m: Extract<ScratchMsg, { t: "scratch-begin" }>): Promise<void> => {
    const fail = (code: Extract<ExecReply, { t: "scratch-failed" }>["code"]): void => send({ t: "scratch-failed", req: m.req, code });
    if (!ATTEMPT_ID.test(m.attempt) || attempts.has(m.attempt)) return fail("bad_bind");
    if (attempts.size >= MAX_ATTEMPTS) return fail("capacity");
    if (!gitDirOk(m.gitDir) || !isAbsolutePath(m.worktree, platform) || hasNul(m.worktree)) return fail("bad_bind");
    const dir = join(root, m.attempt);
    const a: Attempt = { id: m.attempt, dir, gitDir: m.gitDir, worktree: m.worktree, tree: m.tree, manifest: undefined, sizes: new Map(), message: undefined, ready: false };
    const gen = generation;
    attempts.set(a.id, a);
    try {
      mkdirSync(dir, { mode: 0o700 });
      mkdirSync(join(dir, "tree"), { mode: 0o700 });
    } catch {
      dropAttempt(a.id);
      return fail("spawn_failed");
    }
    const outcome = await fill(a);
    // The channel closed (or the attempt was ended) while git ran: the directory is already gone.
    if (gen !== generation || attempts.get(a.id) !== a) return fail("spawn_failed");
    if (outcome !== "ok") {
      dropAttempt(a.id);
      return fail(outcome);
    }
    a.ready = true;
    send({ t: "scratch-ready", req: m.req });
  };

  /** ls-tree, validate, raw blobs, write (symlinks last), then read-tree into both scratch indexes. No checkout-index, no filter. */
  const fill = async (a: Attempt): Promise<"ok" | "bad_tree" | "capacity" | "spawn_failed"> => {
    const live = (): boolean => attempts.get(a.id) === a;
    const ls = await boundRun(a, 1, ["ls-tree", "-r", "-z", "--end-of-options", a.tree]);
    if (ls === undefined || !live()) return "spawn_failed";
    if (ls.truncated) return "capacity";
    if (ls.code !== 0) return "bad_tree";
    const entries = parseLsTree(ls.stdout);
    const manifest = entries === undefined ? undefined : planManifest(entries);
    if (manifest === undefined) return "bad_tree";
    const ids = [...new Set(manifest.entries.filter((e) => e.kind !== "gitlink").map((e) => e.oid))];
    let blobs = new Map<string, Uint8Array>();
    if (ids.length > 0) {
      const cat = await boundRun(a, 1, ["cat-file", "--batch"], Buffer.from(ids.join("\n") + "\n", "utf8"), SCRATCH_LIMITS.totalBytes + ids.length * 100);
      if (cat === undefined || !live()) return "spawn_failed";
      if (cat.truncated) return "capacity";
      const parsed = cat.code === 0 ? parseCatFileBatch(cat.stdout, ids) : undefined;
      if (parsed === undefined) return "bad_tree";
      blobs = parsed;
    }
    try {
      writeScratchTree(join(a.dir, "tree"), manifest, blobs);
    } catch {
      return "bad_tree";
    }
    for (const index of [1, 2] as const) {
      const rt = await boundRun(a, index, ["read-tree", a.tree]);
      if (rt === undefined || !live()) return "spawn_failed";
      if (rt.code !== 0) return "bad_tree";
    }
    a.manifest = manifest;
    for (const [id, b] of blobs) a.sizes.set(id, b.length);
    return "ok";
  };

  const writeTreeOf = async (a: Attempt, index: 1 | 2): Promise<string | undefined> => {
    const r = await boundRun(a, index, ["write-tree"], undefined, 4096);
    const id = r === undefined || r.code !== 0 ? "" : Buffer.from(r.stdout).toString("utf8").trim();
    return OBJECT_ID.test(id) ? id : undefined;
  };

  const verify = async (m: Extract<ScratchMsg, { t: "scratch-verify" }>): Promise<void> => {
    const a = attempts.get(m.attempt);
    if (a === undefined || !a.ready || a.manifest === undefined) return send({ t: "scratch-failed", req: m.req, code: "bad_bind" });
    const s1 = await writeTreeOf(a, 1);
    const s2 = await writeTreeOf(a, 2);
    if (attempts.get(a.id) !== a) return send({ t: "scratch-failed", req: m.req, code: "bad_bind" });
    if (s1 === undefined || s2 === undefined) return send({ t: "scratch-failed", req: m.req, code: "spawn_failed" });
    // Either index changed is a change; report the one that differs from the reviewed tree.
    const staged = s1 !== a.tree ? s1 : s2;
    const files = verifyScratchTree(join(a.dir, "tree"), a.manifest, a.sizes);
    let message: "same" | "changed" = "same";
    if (a.message !== undefined) {
      const back = readMessage(join(a.dir, "msg"), a.message.length);
      message = back !== undefined && back.equals(a.message) ? "same" : "changed";
    }
    send({ t: "scratch-verified", req: m.req, staged, files, message });
  };

  return {
    handle(m) {
      if (m.t === "exec") return void handleExec(m);
      if (m.t === "scratch-begin") return void begin(m);
      if (m.t === "scratch-verify") return void verify(m);
      dropAttempt(m.attempt);
      send({ t: "scratch-ended", req: m.req });
    },
    prepareHook(m) {
      const a = attempts.get(m.attempt);
      if (a === undefined || !a.ready || m.bind.attempt !== m.attempt || m.bind.gitDir !== a.gitDir) return { code: "bad_bind" };
      if (!pty5Clean(m.env)) return { code: "env_denied" };
      if ((m.hook === "commit-msg") !== (m.message !== undefined)) return { code: "bad_bind" };
      const hookFile = checkHook(m.hookPath, m.expectSha256, a);
      if (typeof hookFile !== "string") return hookFile;
      const argv = [hookFile];
      if (m.message !== undefined) {
        const bytes = Buffer.from(m.message, "utf8");
        const p = join(a.dir, "msg");
        try {
          rmSync(p, { force: true });
          const fd = openSync(p, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW, 0o600);
          try {
            for (let off = 0; off < bytes.length; ) off += writeSync(fd, bytes, off, bytes.length - off);
          } finally {
            closeSync(fd);
          }
        } catch {
          return { code: "spawn_failed" };
        }
        a.message = bytes;
        argv.push(p);
      }
      const redirect = redirectFor(a, m.bind.index);
      return { argv, cwd: redirect.workTree, env: buildHookEnv(m.env, redirect) };
    },
    closeAll() {
      generation++;
      for (const c of running) {
        try {
          c.kill();
        } catch {
          /* already gone */
        }
      }
      running.clear();
      for (const id of [...attempts.keys()]) dropAttempt(id);
    },
  };

  /**
   * S-1: immediately before the spawn, the realpath of the hook must be a regular executable file under the bound common
   * dir's `hooks/` or the registered worktree, with the SHA-256 the daemon took from the snapshot. The realpath is what runs.
   */
  function checkHook(hookPath: string, expect: string, a: Attempt): string | { code: SpawnFailCode } {
    if (!isAbsolutePath(hookPath, platform) || hasNul(hookPath)) return { code: "bad_bind" };
    let real: string;
    let roots: string[];
    try {
      real = realpathSync(hookPath);
      let common = a.gitDir;
      try {
        common = resolve(a.gitDir, readFileSync(join(a.gitDir, "commondir"), "utf8").replace(/\r?\n$/, ""));
      } catch {
        /* a main repository: the git dir is the common dir */
      }
      roots = [join(realpathSync(common), "hooks"), realpathSync(a.worktree)];
    } catch {
      return { code: "hook_changed" };
    }
    if (!roots.some((r) => within(r, real))) return { code: "bad_bind" };
    let fd: number;
    try {
      fd = openSync(real, constants.O_RDONLY | O_NOFOLLOW | (constants.O_NONBLOCK ?? 0));
    } catch {
      return { code: "hook_changed" };
    }
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || (st.mode & 0o111) === 0 || st.size > HOOK_MAX_BYTES) return { code: "hook_changed" };
      const h = createHash("sha256");
      const buf = Buffer.alloc(64 * 1024);
      for (let n = readSync(fd, buf); n > 0; n = readSync(fd, buf)) h.update(buf.subarray(0, n));
      return h.digest("hex") === expect ? real : { code: "hook_changed" };
    } catch {
      return { code: "hook_changed" };
    } finally {
      closeSync(fd);
    }
  }
}

/** Reads the message file back without following a link; undefined if it is not a regular file of about the size written. */
function readMessage(p: string, written: number): Buffer | undefined {
  let fd: number;
  try {
    fd = openSync(p, constants.O_RDONLY | O_NOFOLLOW | (constants.O_NONBLOCK ?? 0));
  } catch {
    return undefined;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > written + 1024 * 1024) return undefined;
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, off);
      if (n === 0) break;
      off += n;
    }
    return buf.subarray(0, off);
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}
