// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { isAbsolute as posixAbs, normalize as posixNorm } from "node:path/posix";
import { isAbsolute as winAbs, normalize as winNorm } from "node:path/win32";
import { GitOpsError, OBJECT_ID, isAllowedRefspec, type GitRunRequest, type GitRunResult, type GitRunner } from "@axis/git-ops";
import type { PtyExecCall, PtyExecPort, PtyExit, PtyHandle, PtyPushCall, PtyPushPort } from "../ports/pty.js";

/**
 * `createPtyGitRunner` (docs/design/daemon-host-hooks.md §4.1, "Mapping git-ops' requests"): the ONE place that turns a git-ops
 * `pty`-context request into the pty process's `exec` message. The result is the `ptyRunner` of `createGitPort`.
 *
 * git-ops builds every pty call as `prefix()` (`args.ts`) plus a subcommand. The service refuses any global option after git
 * and emits its own pins, so this adapter accepts EXACTLY git-ops' known leading sequence, in order:
 *
 *   --no-pager --no-replace-objects --git-dir=<g> --work-tree=<w> -c core.fsmonitor=false -c protocol.ext.allow=never
 *   [-c core.hooksPath=<off>] [-c i18n.commitEncoding=utf-8]   (the encoding pin: required for commit-tree, refused elsewhere)
 *
 * and maps every token to a field or pin of the service: `--git-dir`/`--work-tree` become `repo` (the journal's explicit
 * directories, GIT-4; never discovered from `cwd`), and each pin is one the service emits itself on every plain exec
 * (`--no-pager`, `--no-replace-objects`, `core.hooksPath=<its off path>`, `core.fsmonitor=` (empty, stronger than `false`),
 * `protocol.ext.allow=never`, and `i18n.commitEncoding=utf-8` for `commit-tree`). Any other leading token, a value other than
 * the known one, or a missing token is refused: an unknown `-c` is an error, never a pass-through and never dropped.
 *
 * After the prefix only the forms git-ops builds for the pty context are mapped (closed list, exact tokens):
 * `commit-tree [-S] -p <id> -F - <id>` and `config --type=bool --get commit.gpgsign` go to `exec`; git-ops' push (its prefix
 * with the hooks pin, its transport pins, then `push --no-follow-tags --no-recurse-submodules --no-verify -- <remote> <refspec>`)
 * goes to the terminal-bound `push` (§5.2, S4 part 1), carrying only the remote and the one pinned refspec. Everything else is
 * refused. The environment is rebuilt from the service's allow-list only; any other name in
 * git-ops' environment (the PTY-5 copy the host holds) is left out, and the service builds the rest from its own startup
 * environment. Every refusal is a `GitOpsError` with a fixed text: no argv, path, environment or output.
 */
export interface PtyGitRunnerOptions {
  /** The absolute git the pty process was started with (`argv[0]` of every exec; the service checks it too). */
  readonly gitPath: string;
  readonly platform: NodeJS.Platform;
  /** git-ops' hooks-off path (`hooksOffPath()`), the only `core.hooksPath` value accepted. Absent: a request carrying the pin is refused. */
  readonly hooksOffPath?: string;
  /** Bound on each exec (the service kills the group past it). Default 120 s: `commit-tree -S` waits for the signing program. */
  readonly timeoutMs?: number;
  /** Bytes kept per stream. Default 1 MiB (an object id or a config value). */
  readonly maxOutput?: number;
  /**
   * Bound on a push run, from the spawn to its exit; past it the group is killed and the push is `E_UNAVAILABLE`. Default 25 s, under
   * the method's own 30 s (`axis.git/1.push`), so the run never outlives the request or holds the project mutex after the client was
   * answered. The request's signal kills it sooner.
   */
  readonly pushTimeoutMs?: number;
}

/** The names the service takes from a message (`exec-env.ts` EXEC_ALLOW); the rest of git-ops' environment is not sent. */
const ENV_ALLOW = new Set([
  "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_AUTHOR_DATE",
  "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "GIT_COMMITTER_DATE",
  "GIT_TERMINAL_PROMPT", "LANG",
]);
const LC_NAME = /^LC_[A-Z0-9_]{1,64}$/;
/** The push run's default bound: under the 30 s of `axis.git/1.push` (a test compares the two). */
export const DEFAULT_PUSH_TIMEOUT_MS = 25_000;
/** The configuration and ssh variables git-ops validated the push with (the pty process's `PUSH_ENV_NAMES`), sent for comparison. */
const PUSH_ENV_NAMES = ["HOME", "XDG_CONFIG_HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM", "GIT_SSH", "GIT_SSH_COMMAND", "GIT_SSH_VARIANT", "GIT_PROXY_COMMAND"] as const;

/** The service refused the mapped form itself: a wiring fault, not unavailability. Every other failure (closed, busy, slow, no control) is. */
const FORM_REFUSALS: ReadonlySet<unknown> = new Set(["bad_argv", "env_denied", "bad_bind"]);

const unmappable = (): GitOpsError => new GitOpsError("E_INTERNAL", "A git request for the pty process has a form Axis does not map.");
const unavailable = (): GitOpsError => new GitOpsError("E_UNAVAILABLE", "The Axis pty process is not available for git.");
const cancelled = (): GitOpsError => new GitOpsError("E_CANCELLED", "The push was cancelled.");
/** The pty process's own check of the remote refused it (a `remote.<r>.vcs` helper or a helper URL; git-ops refuses these first). */
const remoteRefused = (): GitOpsError => new GitOpsError("E_POLICY_DENIED", "The remote uses a transport helper, which Axis does not push through.");
/**
 * A push with repository hooks on (`axis.git.runHooks`): git-ops leaves out the hooks pin and `--no-verify`, and `pre-push` would
 * run. Running it needs the hook path check of §5.2 (S4 part 2, after S2's resolution), so until then it is refused, never run
 * unchecked and never silently run without its hook (H-5). The reason is the host's own and not on the wire.
 */
export const PUSH_HOOKS_UNAVAILABLE = "hooks_unavailable";
const pushHooksUnavailable = (): GitOpsError => new GitOpsError("E_UNAVAILABLE", "Pushing with repository hooks through the Axis pty process is not available yet.", { reason: PUSH_HOOKS_UNAVAILABLE });
/** git-ops' push transport pins (`protocolAllowList()`), exactly and in order. The pty process emits its own for the same four. */
const PUSH_PINS = ["protocol.allow=never", "protocol.https.allow=always", "protocol.ssh.allow=always", "protocol.git.allow=always", "protocol.file.allow=always"];
/** git-ops' `REMOTE_NAME`: a configured remote, never a URL, a path or an option. */
const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

interface MappedPush {
  readonly push: true;
  readonly gitDir: string;
  readonly workTree: string;
  readonly hooks: boolean;
  readonly remote: string;
  readonly refspec: string;
}

interface Mapped {
  readonly gitDir: string;
  readonly workTree: string;
  readonly sub: string;
  readonly rest: readonly string[];
}

function absNormal(p: string, platform: NodeJS.Platform): boolean {
  if (p.length === 0 || p.includes("\0")) return false;
  const win = platform === "win32";
  const trim = (s: string): string => s.replace(/[\\/]+$/, "");
  return (win ? winAbs(p) : posixAbs(p)) && trim(win ? winNorm(p) : posixNorm(p)) === trim(p);
}

/** Reads git-ops' leading options exactly; git-ops' push form maps to a push run; undefined for anything else. */
export function mapPtyArgv(argv: readonly string[], o: Pick<PtyGitRunnerOptions, "platform" | "hooksOffPath">): Mapped | MappedPush | undefined {
  let i = 0;
  const next = (): string | undefined => argv[i++];
  const take = (want: string): boolean => argv[i] === want && (i++, true);
  const pair = (value: string): boolean => argv[i] === "-c" && argv[i + 1] === value && ((i += 2), true);
  const valued = (flag: string): string | undefined => {
    const a = next();
    return a !== undefined && a.startsWith(flag) ? a.slice(flag.length) : undefined;
  };
  if (!take("--no-pager") || !take("--no-replace-objects")) return undefined;
  const gitDir = valued("--git-dir=");
  const workTree = valued("--work-tree=");
  if (gitDir === undefined || workTree === undefined || !absNormal(gitDir, o.platform) || !absNormal(workTree, o.platform)) return undefined;
  if (!pair("core.fsmonitor=false") || !pair("protocol.ext.allow=never")) return undefined;
  let hooksPinned = false;
  if (argv[i] === "-c" && argv[i + 1]?.startsWith("core.hooksPath=")) {
    if (o.hooksOffPath === undefined || o.hooksOffPath.length === 0 || !pair(`core.hooksPath=${o.hooksOffPath}`)) return undefined;
    hooksPinned = true;
  }
  if (argv[i] === "-c" && argv[i + 1] === PUSH_PINS[0]) {
    for (const pin of PUSH_PINS) if (!pair(pin)) return undefined;
    return mapPush(argv.slice(i), gitDir, workTree, hooksPinned);
  }
  const encoding = pair("i18n.commitEncoding=utf-8");
  const sub = next();
  if (sub === undefined) return undefined;
  const rest = argv.slice(i);
  // The encoding pin belongs to commit-tree (the secret scan reads the message as UTF-8) and to nothing else.
  if ((sub === "commit-tree") !== encoding) return undefined;
  if (!subcommandOk(sub, rest)) return undefined;
  return { gitDir, workTree, sub, rest };
}

/**
 * git-ops' push after its pins, as exact tokens: `push --no-follow-tags --no-recurse-submodules [--no-verify] -- <remote> <refspec>`.
 * `--no-verify` exactly when the hooks pin is there (both say "hooks off"); the remote a configured name, the refspec the one pinned
 * form (`<id>:refs/heads/axis/<slug>`: no force, no other ref). Anything else, including a `--force` or a second refspec, is undefined.
 */
function mapPush(rest: readonly string[], gitDir: string, workTree: string, hooksPinned: boolean): MappedPush | undefined {
  const want = ["push", "--no-follow-tags", "--no-recurse-submodules", ...(hooksPinned ? ["--no-verify"] : []), "--"];
  if (rest.length !== want.length + 2 || !want.every((w, k) => rest[k] === w)) return undefined;
  const remote = rest[want.length] as string;
  const refspec = rest[want.length + 1] as string;
  if (!REMOTE_NAME.test(remote) || !isAllowedRefspec(refspec)) return undefined;
  return { push: true, gitDir, workTree, hooks: !hooksPinned, remote, refspec };
}

/** The forms git-ops sends to the pty context, as exact tokens. */
function subcommandOk(sub: string, rest: readonly string[]): boolean {
  const exactly = (want: readonly string[]): boolean => rest.length === want.length && want.every((w, k) => rest[k] === w);
  if (sub === "config") return exactly(["--type=bool", "--get", "commit.gpgsign"]);
  if (sub === "commit-tree") {
    const r = rest[0] === "-S" ? rest.slice(1) : rest;
    return r.length === 5 && r[0] === "-p" && OBJECT_ID.test(r[1] as string) && r[2] === "-F" && r[3] === "-" && OBJECT_ID.test(r[4] as string);
  }
  return false;
}

/** The allow-listed names of git-ops' environment; a NUL in a kept value refuses the call. */
function allowedEnv(env: Readonly<Record<string, string>>): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    // Case-insensitive, as the service's own check (`execNameAllowed`) and Windows environment names are.
    const upper = name.toUpperCase();
    if (!ENV_ALLOW.has(upper) && !LC_NAME.test(upper)) continue;
    if (typeof value !== "string" || value.includes("\0")) return undefined;
    out[name] = value;
  }
  return out;
}

/**
 * The `pty` context runner over the pty process's `exec` and `push`. `port` absent (no pty process, or one without `exec`, or
 * without `push` for a push): the call is `E_UNAVAILABLE`, nothing runs in the daemon. A `daemon` context call is refused: this
 * runner never serves it.
 */
export function createPtyGitRunner(port: (PtyExecPort & Partial<PtyPushPort>) | undefined, options: PtyGitRunnerOptions): GitRunner {
  if (!absNormal(options.gitPath, options.platform)) throw new TypeError("the pty git runner needs the absolute git path of the pty process");
  const timeoutMs = options.timeoutMs ?? 120_000;
  const maxOutput = options.maxOutput ?? 1024 * 1024;
  const pushTimeoutMs = options.pushTimeoutMs ?? DEFAULT_PUSH_TIMEOUT_MS;
  let runs = 0;
  return {
    async run(req: GitRunRequest): Promise<GitRunResult> {
      if (req.context !== "pty") throw unmappable();
      // The exec reply is decoded text; a request that needs the bytes (`raw`) cannot be honoured, so it is not sent.
      if (req.raw === true) throw unmappable();
      const m = mapPtyArgv(req.argv, options);
      const env = allowedEnv(req.env);
      if (m === undefined || env === undefined || !absNormal(req.cwd, options.platform)) throw unmappable();
      if ("push" in m) {
        if (m.hooks) throw pushHooksUnavailable();
        // git-ops' push writes nothing to stdin; a push request that does is not its form.
        if (req.stdin !== undefined) throw unmappable();
        if (port === undefined || typeof port.push !== "function") throw unavailable();
        // Exactly the names git-ops checked, from the environment it checked them in (git-ops' push command carries its pty copy).
        const expectEnv = Object.fromEntries(PUSH_ENV_NAMES.map((n) => [n, Object.hasOwn(req.env, n) && typeof req.env[n] === "string" ? req.env[n] : null])) as PtyPushCall["expectEnv"];
        const call: PtyPushCall = { runId: `git-push-${++runs}`, repo: { gitDir: m.gitDir, workTree: m.workTree }, remote: m.remote, refspec: m.refspec, env, expectEnv, cols: 120, rows: 30 };
        const code = await runPush(port as PtyPushPort, call, pushTimeoutMs, req.signal);
        // The exit status is the only thing read (H-7): git's and the transport's output went to the terminal, never here.
        return { code, stdout: "", stderr: "" };
      }
      if (port === undefined || typeof port.exec !== "function") throw unavailable();
      const call: PtyExecCall = {
        argv: [options.gitPath, m.sub, ...m.rest],
        cwd: req.cwd,
        env,
        ...(req.stdin === undefined ? {} : { stdin: req.stdin }),
        timeoutMs,
        maxOutput,
        repo: { gitDir: m.gitDir, workTree: m.workTree },
      };
      let r;
      try {
        r = await port.exec(call);
      } catch (e) {
        throw FORM_REFUSALS.has((e as { code?: unknown } | null)?.code) ? unmappable() : unavailable();
      }
      // Killed by a signal: no exit status to report, so the call failed.
      if (r.code === null) throw unavailable();
      return { code: r.code, stdout: r.stdout, stderr: r.stderr, ...(r.truncated ? { truncated: true } : {}) };
    },
  };
}

/**
 * One push run: spawned as a terminal in the pty process, then its exit status under `ms`. Past the bound, or when the pty process
 * reports no status, the group is killed and the push is `E_UNAVAILABLE` (it may have reached the remote: a retry is a fresh tier 4
 * request and a no-op push). The request's signal kills it and answers `E_CANCELLED`. A process still in the group after git exited
 * is killed too; it cannot change the verdict. The pty process's own refusal of the remote (`remote_refused`) is `E_POLICY_DENIED`.
 */
async function runPush(port: PtyPushPort, call: PtyPushCall, ms: number, signal: AbortSignal | undefined): Promise<number> {
  if (signal?.aborted === true) throw cancelled();
  let h: PtyHandle;
  try {
    h = await port.push(call);
  } catch (e) {
    const code = (e as { code?: unknown } | null)?.code;
    if (code === "remote_refused") throw remoteRefused();
    throw FORM_REFUSALS.has(code) ? unmappable() : unavailable();
  }
  const kill = (): void => {
    try {
      h.kill("SIGKILL");
    } catch {
      /* the group is gone or unreachable; groupAlive stays the guard */
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sub: { dispose(): void } | undefined;
  let onAbort: (() => void) | undefined;
  const exit = await new Promise<PtyExit | "timeout" | "aborted">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
    sub = h.onExit(resolve);
    onAbort = () => resolve("aborted");
    if (signal?.aborted === true) resolve("aborted");
    signal?.addEventListener("abort", onAbort, { once: true });
  }).finally(() => {
    clearTimeout(timer);
    sub?.dispose();
    if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
  });
  let alive = true;
  try {
    alive = typeof exit === "string" || h.groupAlive();
  } catch {
    alive = true; // unknown counts as alive
  }
  if (alive) kill();
  if (exit === "aborted") throw cancelled();
  if (exit === "timeout" || exit.exitCode === null) throw unavailable();
  return exit.exitCode;
}

/**
 * The composition's one choice of the `pty` git context (called by `composeDaemonHost` only): a pty port with `exec` gets
 * `createPtyGitRunner` over it (the git path is the host's one `gitPath`, known after storage, so this returns a factory), and
 * a caller's runner as well is refused (`pty_git_runner_conflict`: two sources, one would be silently ignored). Without `exec`
 * the caller's runner is required (`pty_git_runner_required`; test fakes). The hooks-off path is git-ops' POSIX one; on
 * Windows the host wires no empty hooks directory, so a request that carries the pin is refused.
 */
export function selectPtyGitRunner(
  pty: (Partial<PtyExecPort> & Partial<PtyPushPort>) | undefined,
  explicit: GitRunner | undefined,
  platform: NodeJS.Platform,
): ((gitPath: string) => GitRunner) | "pty_git_runner_conflict" | "pty_git_runner_required" {
  if (pty !== undefined && typeof pty.exec === "function") {
    if (explicit !== undefined) return "pty_git_runner_conflict";
    const exec = pty.exec.bind(pty);
    const push = typeof pty.push === "function" ? { push: pty.push.bind(pty) } : {};
    return (gitPath) => createPtyGitRunner({ exec, ...push }, { gitPath, platform, ...(platform === "win32" ? {} : { hooksOffPath: "/dev/null" }) });
  }
  if (typeof (explicit as { run?: unknown } | undefined)?.run !== "function") return "pty_git_runner_required";
  const runner = explicit as GitRunner;
  return () => runner;
}
