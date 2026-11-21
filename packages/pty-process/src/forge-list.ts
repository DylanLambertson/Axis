// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The pty process's `forge-list` message (ticket PV-D2 slice 1b, docs/design/forge-pr-list.md §1, §4, §7). The daemon names a
// vetted github.com repository and nothing else; this file composes the command from a closed template, runs `gh` through its
// own exec function in a fresh private directory, and answers with the exit code, a closed stderr class and the bounded stdout.
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FORGE_MAX_STDOUT, forgeListRequestSchema, type ForgeFailureCode, type ForgeListRequest, type ForgeReply } from "@axis/protocol";
import { buildForgeEnv, classifyForgeStderr, FORGE_CONFIG_FILES, forgeListArgv, forgeVersionArgv, ghAtLeast, MIN_GH_VERSION, parseGhVersion, type ForgeCallDirs, type GhVersion } from "./forge-env.js";
import { removeTree } from "./git-exec.js";
import { isAbsolutePath } from "./paths.js";
import { ExecStartError, type Clock, type ExecChild, type ExecFn, type ExecOutcome } from "./ports.js";

export interface ForgeListConfig {
  /** The forge path's own exec function: `createNodeExec(new Set([ghPath]), platform)` in production, never the git one. */
  readonly exec: ExecFn;
  /** The absolute `gh` (`AXIS_PTY_GH`). Absent: every `forge-list` answers `spawn_missing`. */
  readonly ghPath: string | undefined;
  /** The pty process's private directory; this file owns `<scratchParent>/forge-calls` and sweeps it at start. */
  readonly scratchParent: string;
  /** The pty process's startup environment (main's, PTY-5 clean); only the allow-listed names are copied from it. */
  readonly baseEnv: Readonly<Record<string, string | undefined>>;
  /** `forge-list` calls at once across all projects; the next one is `capacity`. Default 2. */
  readonly maxCalls?: number;
  /** Bound on the list call. Default 20 s. */
  readonly timeoutMs?: number;
  /** Bound on the version step. Default 5 s. */
  readonly versionTimeoutMs?: number;
  /** Default `MIN_GH_VERSION`. */
  readonly minVersion?: GhVersion;
  /** `false` is the gate's fallback template (no `--author=@me`). Default true. */
  readonly authorFilter?: boolean;
}

/**
 * TEST ONLY (review S1b N-4): not part of the configuration the service and the entry pass. Only a test constructs the forge
 * path with it, through `createForgeList` from this file (the package index does not export that function).
 */
export interface ForgeListTestSeams {
  /** Runs after a call directory is prepared and before it is checked (a same-user process racing the window). */
  readonly afterPrepare?: (callDir: string) => void;
}

export interface ForgeList {
  /** A control message whose `t` is `forge-list`; it is parsed here with the shared schema. */
  handle(raw: unknown): void;
  /** The control channel closed or the service is disposed: kill every call; no reply is sent for them. */
  closeAll(): void;
}

export const FORGE_LIMITS = { maxCalls: 2, timeoutMs: 20_000, versionTimeoutMs: 5_000, maxStderr: 64 * 1024, versionOutput: 4096 } as const;
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const REQ = /^[A-Za-z0-9_-]{1,64}$/;

/** The `req` of a `forge-list` message that failed its schema, when it has a usable one (so the daemon is not left waiting). */
export function forgeRequestId(raw: unknown): string | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as { t?: unknown; req?: unknown };
  return r.t === "forge-list" && typeof r.req === "string" && REQ.test(r.req) ? r.req : undefined;
}

/** Exactly `want`'s bytes, read without following a link, from a regular file. */
function sameBytes(path: string, want: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | O_NOFOLLOW);
    if (!fstatSync(fd).isFile()) return false;
    const expected = Buffer.from(want, "utf8");
    const buf = Buffer.alloc(expected.length + 1);
    let n = 0;
    for (let k = 1; k > 0 && n < buf.length; n += k) k = readSync(fd, buf, n, buf.length - n, null);
    return n === expected.length && buf.subarray(0, n).equals(expected);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const realDir = (p: string): boolean => {
  try {
    const st = lstatSync(p);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
};
const exactly = (dir: string, names: readonly string[]): boolean => {
  try {
    const got = readdirSync(dir).sort();
    return got.length === names.length && got.every((n, i) => n === names[i]);
  } catch {
    return false;
  }
};

/** Checked immediately before the exec (§1): `cwd/` and `data/` empty, `config/` exactly the generated files, nothing else. */
export function forgeCallIntact(callDir: string): boolean {
  const config = join(callDir, "config");
  const files = Object.keys(FORGE_CONFIG_FILES).sort();
  return (
    exactly(callDir, ["config", "cwd", "data"]) &&
    ["config", "cwd", "data"].every((d) => realDir(join(callDir, d))) &&
    exactly(join(callDir, "cwd"), []) &&
    exactly(join(callDir, "data"), []) &&
    exactly(config, files) &&
    files.every((f) => sameBytes(join(config, f), FORGE_CONFIG_FILES[f] as string))
  );
}

type RunResult = ExecOutcome | { readonly fail: ForgeFailureCode };

const startCode = (e: unknown): ForgeFailureCode => {
  if (!(e instanceof ExecStartError)) return "spawn_failed";
  if (e.code === "not_found") return "spawn_missing";
  if (e.code === "unsupported_platform") return "unsupported_platform";
  return "spawn_failed"; // program_refused (a bug), not_permitted, start_failed
};

export function createForgeList(cfg: ForgeListConfig, clock: Clock, platform: NodeJS.Platform, send: (m: ForgeReply) => void, seams: ForgeListTestSeams = {}): ForgeList {
  // Windows has no process group to kill (the job object is PV-X1w): every valid request is refused and nothing is created.
  if (platform === "win32") {
    return {
      handle(raw) {
        const parsed = forgeListRequestSchema.safeParse(raw);
        const req = parsed.success ? parsed.data.req : forgeRequestId(raw);
        if (req !== undefined) send({ t: "forge-failed", req, code: parsed.success ? "unsupported_platform" : "bad_request" });
      },
      closeAll: () => undefined,
    };
  }
  if (!isAbsolutePath(cfg.scratchParent, platform) || (cfg.ghPath !== undefined && !isAbsolutePath(cfg.ghPath, platform))) {
    throw new Error("the forge configuration needs an absolute gh path and an absolute scratch parent");
  }
  const maxCalls = cfg.maxCalls ?? FORGE_LIMITS.maxCalls;
  const floor = cfg.minVersion ?? MIN_GH_VERSION;
  const root = join(cfg.scratchParent, "forge-calls");
  // Swept at start, links not followed: nothing a crashed earlier process left can reach a call.
  removeTree(root);
  mkdirSync(root, { mode: 0o700 });
  chmodSync(root, 0o700);

  const running = new Set<ExecChild>();
  let generation = 0;
  let inflight = 0;
  let versionOk = false;
  let versionRun: Promise<ForgeFailureCode | "ok"> | undefined;

  /** A fresh 0700 directory with `cwd/`, `config/` (the generated files) and `data/`; undefined when any step fails. */
  const prepare = (): { dir: string; dirs: ForgeCallDirs } | undefined => {
    const dir = join(root, randomBytes(16).toString("hex"));
    try {
      mkdirSync(dir, { mode: 0o700 });
      for (const d of ["cwd", "config", "data"]) mkdirSync(join(dir, d), { mode: 0o700 });
      for (const [name, text] of Object.entries(FORGE_CONFIG_FILES)) writeFileSync(join(dir, "config", name), text, { mode: 0o600, flag: "wx" });
    } catch {
      removeTree(dir);
      return undefined;
    }
    return { dir, dirs: { cwd: join(dir, "cwd"), config: join(dir, "config"), data: join(dir, "data"), state: join(dir, "state"), cache: join(dir, "cache") } };
  };

  /** One `gh` run in its own call directory, removed once the exec settled (its group is gone). Never throws. */
  const run = (argv: (gh: string) => string[], ms: number, maxOutput: number, maxStderr: number): Promise<RunResult> => {
    const gh = cfg.ghPath;
    if (gh === undefined) return Promise.resolve({ fail: "spawn_missing" });
    const call = prepare();
    if (call === undefined) return Promise.resolve({ fail: "spawn_failed" });
    seams.afterPrepare?.(call.dir);
    if (!forgeCallIntact(call.dir)) {
      removeTree(call.dir);
      return Promise.resolve({ fail: "spawn_failed" });
    }
    let child: ExecChild;
    try {
      child = cfg.exec({ argv: argv(gh), cwd: call.dirs.cwd, env: buildForgeEnv(cfg.baseEnv, call.dirs, platform), maxOutput, maxStderr });
    } catch (e) {
      removeTree(call.dir);
      return Promise.resolve({ fail: startCode(e) });
    }
    running.add(child);
    const settled = child.done.finally(() => {
      running.delete(child);
      removeTree(call.dir);
    });
    return new Promise((res) => {
      let done = false;
      const timer = clock.setTimeout(() => {
        if (done) return;
        done = true;
        try {
          child.kill();
        } catch {
          /* gone */
        }
        res({ fail: "timeout" });
      }, ms);
      settled.then(
        (o) => {
          if (done) return;
          done = true;
          clock.clearTimeout(timer);
          res(o);
        },
        (e: unknown) => {
          if (done) return;
          done = true;
          clock.clearTimeout(timer);
          res({ fail: startCode(e) });
        },
      );
    });
  };

  /** Once per process on success; a failure is not kept, so the next call checks again. Concurrent first calls share one run. */
  const checkVersion = (): Promise<ForgeFailureCode | "ok"> => {
    if (versionOk) return Promise.resolve("ok");
    if (versionRun !== undefined) return versionRun;
    const p = run(forgeVersionArgv, cfg.versionTimeoutMs ?? FORGE_LIMITS.versionTimeoutMs, FORGE_LIMITS.versionOutput, FORGE_LIMITS.versionOutput).then((r): ForgeFailureCode | "ok" => {
      if ("fail" in r) return r.fail;
      const v = r.code === 0 && !r.stdoutTruncated ? parseGhVersion(Buffer.from(r.stdout).toString("utf8")) : undefined;
      if (v === undefined) return "version_unknown";
      if (!ghAtLeast(v, floor)) return "too_old";
      versionOk = true;
      return "ok";
    });
    versionRun = p;
    void p.finally(() => {
      if (versionRun === p) versionRun = undefined;
    });
    return p;
  };

  const list = async (m: ForgeListRequest, gen: number): Promise<ForgeReply> => {
    const failed = (code: ForgeFailureCode): ForgeReply => ({ t: "forge-failed", req: m.req, code });
    const v = await checkVersion();
    if (v !== "ok") return failed(v);
    if (gen !== generation) return failed("no_control");
    const r = await run((gh) => forgeListArgv(gh, m.owner, m.repo, cfg.authorFilter ?? true), cfg.timeoutMs ?? FORGE_LIMITS.timeoutMs, FORGE_MAX_STDOUT, FORGE_LIMITS.maxStderr);
    if ("fail" in r) return failed(r.fail);
    // The caps hold even if the exec function kept more. A cut list is never sent: the daemon answers output_too_large.
    const truncated = r.stdoutTruncated || r.stdout.length > FORGE_MAX_STDOUT;
    const exit = r.code !== null && Number.isInteger(r.code) && r.code >= 0 && r.code <= 255 ? r.code : null;
    const stderr = Buffer.from(r.stderr.subarray(0, FORGE_LIMITS.maxStderr)).toString("utf8");
    return { t: "forge-result", req: m.req, exit, class: classifyForgeStderr(exit, stderr, m.owner, m.repo), stdout: truncated ? "" : Buffer.from(r.stdout).toString("utf8"), truncated };
  };

  return {
    handle(raw) {
      const parsed = forgeListRequestSchema.safeParse(raw);
      if (!parsed.success) {
        const req = forgeRequestId(raw);
        if (req !== undefined) send({ t: "forge-failed", req, code: "bad_request" });
        return;
      }
      const m = parsed.data;
      if (cfg.ghPath === undefined) return send({ t: "forge-failed", req: m.req, code: "spawn_missing" });
      if (inflight >= maxCalls) return send({ t: "forge-failed", req: m.req, code: "capacity" });
      inflight++;
      const gen = generation;
      void list(m, gen)
        .catch((): ForgeReply => ({ t: "forge-failed", req: m.req, code: "spawn_failed" }))
        .then((reply) => {
          inflight--;
          if (gen === generation) send(reply);
        });
    },
    closeAll() {
      generation++;
      // A version run killed here must not be joined by the next channel's first call (review S1b N-2).
      versionRun = undefined;
      for (const c of [...running]) {
        try {
          c.kill();
        } catch {
          /* gone */
        }
      }
    },
  };
}
