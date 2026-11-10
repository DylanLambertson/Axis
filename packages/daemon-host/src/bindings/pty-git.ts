// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { isAbsolute as posixAbs, normalize as posixNorm } from "node:path/posix";
import { isAbsolute as winAbs, normalize as winNorm } from "node:path/win32";
import { GitOpsError, OBJECT_ID, type GitRunRequest, type GitRunResult, type GitRunner } from "@axis/git-ops";
import type { PtyExecCall, PtyExecPort } from "../ports/pty.js";

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
 * `commit-tree [-S] -p <id> -F - <id>` and `config --type=bool --get commit.gpgsign`. Everything else (push, which is a
 * terminal-bound run, §5.2) is refused. The environment is rebuilt from the service's allow-list only; any other name in
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
}

/** The names the service takes from a message (`exec-env.ts` EXEC_ALLOW); the rest of git-ops' environment is not sent. */
const ENV_ALLOW = new Set([
  "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_AUTHOR_DATE",
  "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "GIT_COMMITTER_DATE",
  "GIT_TERMINAL_PROMPT", "LANG",
]);
const LC_NAME = /^LC_[A-Z0-9_]{1,64}$/;

/** The service refused the mapped form itself: a wiring fault, not unavailability. Every other failure (closed, busy, slow, no control) is. */
const FORM_REFUSALS: ReadonlySet<unknown> = new Set(["bad_argv", "env_denied", "bad_bind"]);

const unmappable = (): GitOpsError => new GitOpsError("E_INTERNAL", "A git request for the pty process has a form Axis does not map.");
const unavailable = (): GitOpsError => new GitOpsError("E_UNAVAILABLE", "The Axis pty process is not available for git.");
/**
 * git-ops' push, recognised only to say it is not built: push is a terminal-bound run (design §5.2), which H9-hooks slice S4
 * builds. Until then a host wired with an `exec` port answers every push with this, never as an internal fault. The reason is
 * the host's own; it is not in the wire's closed sets, so the client sees `E_UNAVAILABLE` with the fixed text of the code.
 */
export const PUSH_NOT_AVAILABLE = "push_not_available";
const pushUnavailable = (): GitOpsError => new GitOpsError("E_UNAVAILABLE", "Pushing through the Axis pty process is not available yet.", { reason: PUSH_NOT_AVAILABLE });
/** git-ops' push transport pins (`protocolAllowList()`): `protocol.allow=never`, then per-protocol `always`. */
const PUSH_PIN = /^protocol\.[a-z][a-z0-9+.-]{0,31}\.allow=always$/;

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

/** Reads git-ops' leading options exactly; `"push"` for git-ops' push form (not built, S4); undefined for anything else. */
export function mapPtyArgv(argv: readonly string[], o: Pick<PtyGitRunnerOptions, "platform" | "hooksOffPath">): Mapped | "push" | undefined {
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
  if (argv[i] === "-c" && argv[i + 1]?.startsWith("core.hooksPath=")) {
    if (o.hooksOffPath === undefined || o.hooksOffPath.length === 0 || !pair(`core.hooksPath=${o.hooksOffPath}`)) return undefined;
  }
  if (argv[i] === "-c" && argv[i + 1] === "protocol.allow=never") {
    let j = i + 2;
    while (argv[j] === "-c" && PUSH_PIN.test(argv[j + 1] ?? "")) j += 2;
    if (argv[j] === "push") return "push";
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
 * The `pty` context runner over the pty process's `exec`. `port` absent (no pty process, or one without `exec`): every call is
 * `E_UNAVAILABLE`, nothing runs in the daemon. A `daemon` context call is refused: this runner never serves it.
 */
export function createPtyGitRunner(port: PtyExecPort | undefined, options: PtyGitRunnerOptions): GitRunner {
  if (!absNormal(options.gitPath, options.platform)) throw new TypeError("the pty git runner needs the absolute git path of the pty process");
  const timeoutMs = options.timeoutMs ?? 120_000;
  const maxOutput = options.maxOutput ?? 1024 * 1024;
  return {
    async run(req: GitRunRequest): Promise<GitRunResult> {
      if (req.context !== "pty") throw unmappable();
      // The exec reply is decoded text; a request that needs the bytes (`raw`) cannot be honoured, so it is not sent.
      if (req.raw === true) throw unmappable();
      const m = mapPtyArgv(req.argv, options);
      if (m === "push") throw pushUnavailable();
      const env = allowedEnv(req.env);
      if (m === undefined || env === undefined || !absNormal(req.cwd, options.platform)) throw unmappable();
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
 * The composition's one choice of the `pty` git context (called by `composeDaemonHost` only): a pty port with `exec` gets
 * `createPtyGitRunner` over it (the git path is the host's one `gitPath`, known after storage, so this returns a factory), and
 * a caller's runner as well is refused (`pty_git_runner_conflict`: two sources, one would be silently ignored). Without `exec`
 * the caller's runner is required (`pty_git_runner_required`; test fakes). The hooks-off path is git-ops' POSIX one; on
 * Windows the host wires no empty hooks directory, so a request that carries the pin is refused.
 */
export function selectPtyGitRunner(
  pty: Partial<PtyExecPort> | undefined,
  explicit: GitRunner | undefined,
  platform: NodeJS.Platform,
): ((gitPath: string) => GitRunner) | "pty_git_runner_conflict" | "pty_git_runner_required" {
  if (pty !== undefined && typeof pty.exec === "function") {
    if (explicit !== undefined) return "pty_git_runner_conflict";
    const exec = pty.exec.bind(pty);
    return (gitPath) => createPtyGitRunner({ exec }, { gitPath, platform, ...(platform === "win32" ? {} : { hooksOffPath: "/dev/null" }) });
  }
  if (typeof (explicit as { run?: unknown } | undefined)?.run !== "function") return "pty_git_runner_required";
  const runner = explicit as GitRunner;
  return () => runner;
}
