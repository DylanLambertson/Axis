// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// H9-hooks slice S4 part 1: `git push` as a terminal-bound run (docs/design/daemon-host-hooks.md §5.2,
// docs/design/daemon-host-hooks-s4.md). The service builds the whole argv and environment itself from closed fields; the
// message names a repository, a configured remote and the one pinned refspec, and nothing else.
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { relative, resolve, isAbsolute as nodeAbsolute } from "node:path";
import { plainPrefix } from "./exec-argv.js";
import { buildExecEnv } from "./exec-env.js";
import type { ControlReply, ControlRequest } from "./messages.js";
import { hasNul, isAbsolutePath } from "./paths.js";
import type { Clock, ExecChild, ExecFn } from "./ports.js";

/** A configured remote name (git-ops' `REMOTE_NAME`): never a URL, a path or an option. */
export const PUSH_REMOTE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/**
 * The one refspec Axis pushes (git-ops' `isAllowedRefspec`): a full object id into `refs/heads/axis/<slug>`. No `+` (force),
 * no wildcard, no tag, no delete, no other namespace.
 */
export const PUSH_REFSPEC = /^(?:[0-9a-f]{40}|[0-9a-f]{64}):refs\/heads\/axis\/[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
/** The transports a push may use (git-ops' `PUSH_PROTOCOLS`), as the `GIT_ALLOW_PROTOCOL` list. */
export const PUSH_TRANSPORTS = ["https", "ssh", "git", "file"] as const;
/**
 * The variables that choose which configuration and which ssh the push's git uses. The host sends the values it validated (git-ops
 * reads the destination and the GIT-7 checks with them); the service's own environment must hold exactly these values, or the push
 * is `env_denied` (an approval names a destination only as the daemon's git saw it). `null` is "not set".
 */
export const PUSH_ENV_NAMES = ["HOME", "XDG_CONFIG_HOME", "GIT_CONFIG", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM", "GIT_SSH", "GIT_SSH_COMMAND", "GIT_SSH_VARIANT", "GIT_PROXY_COMMAND"] as const;
export type PushEnvName = (typeof PUSH_ENV_NAMES)[number];
/**
 * The only `GIT_*` names a push (and its remote check) keeps from the startup environment, by an allow-list (review 2 SF-1): the
 * compared configuration and ssh names except the legacy `GIT_CONFIG` (which makes `git config` read only that file, blinding the
 * remote check; compared AND dropped), the trust roots for https, and what the service sets itself. Every other `GIT_*` name
 * (`GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_COUNT`/`KEY_n`/`VALUE_n`, the location names `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`,
 * `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_COMMON_DIR`, `GIT_NAMESPACE`, `GIT_EXEC_PATH`,
 * `GIT_TEMPLATE_DIR`, `GIT_ATTR_SOURCE`, `GIT_TRACE*`, `GIT_SSL_NO_VERIFY`, ...) is removed, whatever its case.
 */
const PUSH_GIT_KEEP: ReadonlySet<string> = new Set([
  "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM", "GIT_SSH", "GIT_SSH_COMMAND", "GIT_SSH_VARIANT", "GIT_PROXY_COMMAND",
  "GIT_SSL_CAINFO", "GIT_SSL_CAPATH",
  "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_AUTHOR_DATE", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "GIT_COMMITTER_DATE",
  "GIT_TERMINAL_PROMPT", "GIT_NO_LAZY_FETCH", "GIT_ALLOW_PROTOCOL",
]);
/** Removes every `GIT_*` name outside `PUSH_GIT_KEEP` (any case). A second layer: PTY-5 already drops the redirect and config-injection names. */
export function keepGitNames(env: Record<string, string>): void {
  for (const k of Object.keys(env)) {
    const u = k.toUpperCase();
    if (u.startsWith("GIT_") && !PUSH_GIT_KEEP.has(u)) delete env[k];
  }
}

type PushMsg = Extract<ControlRequest, { t: "push" }>;
type SpawnFailCode = Extract<ControlReply, { t: "spawn-failed" }>["code"];

export interface PushRunConfig {
  readonly gitPath: string;
  readonly hooksOff: string;
  readonly baseEnv: Readonly<Record<string, string | undefined>>;
  /** Execs the remote check (`vetPushRemote`). */
  readonly exec: ExecFn;
}

/**
 * The argv of a push. The pins are those of every plain exec (hooks off, fsmonitor empty, no transport but the listed ones, no
 * autocorrect onto an alias) plus the per-transport allows and an EMPTY alias for each `remote-<transport>` (git runs an empty
 * alias as an error, never as a command: a helper named by `remote.<r>.vcs` or a `<t>::` URL cannot reach a repository alias);
 * then a push that follows no tags, recurses into no submodule and runs no hook (`--no-verify` as well as the hooks pin).
 */
export function pushArgv(cfg: Pick<PushRunConfig, "gitPath" | "hooksOff">, repo: { gitDir: string; workTree: string }, remote: string, refspec: string): string[] {
  return [
    cfg.gitPath,
    "--no-pager", "--no-replace-objects", `--git-dir=${repo.gitDir}`, `--work-tree=${repo.workTree}`,
    "-c", `core.hooksPath=${cfg.hooksOff}`,
    "-c", "core.fsmonitor=",
    "-c", "protocol.allow=never",
    "-c", "protocol.ext.allow=never",
    "-c", "help.autocorrect=0",
    ...PUSH_TRANSPORTS.flatMap((p) => ["-c", `protocol.${p}.allow=always`]),
    ...PUSH_TRANSPORTS.flatMap((p) => ["-c", `alias.remote-${p}=`]),
    "push", "--no-follow-tags", "--no-recurse-submodules", "--no-verify",
    "--", remote, refspec,
  ];
}

/** Sets `name` (replacing any spelling of it in another case). */
function put(env: Record<string, string>, name: string, value: string): void {
  for (const k of Object.keys(env)) if (k.toUpperCase() === name) delete env[k];
  env[name] = value;
}

/** Whether `p` is `root` or inside it. */
const within = (root: string, p: string): boolean => {
  const r = relative(root, p);
  return r === "" || (!r.startsWith("..") && !nodeAbsolute(r));
};
const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

/**
 * The push's `PATH`: absolute entries only, none inside the work tree or the git directory (by spelling and by real path, either
 * side), so neither a relative entry (`.`, `node_modules/.bin`) nor one into the checkout can supply the `ssh`, a `git-remote-<t>`
 * or a credential helper git looks up for the push.
 */
export function pushPath(path: string | undefined, roots: readonly string[], platform: NodeJS.Platform): string {
  const sep = platform === "win32" ? ";" : ":";
  const rootsReal = roots.flatMap((r) => [resolve(r), real(r)]);
  return (path ?? "")
    .split(sep)
    .filter((e) => isAbsolutePath(e, platform) && !rootsReal.some((r) => within(r, resolve(e)) || within(r, real(e))))
    .join(sep);
}

export interface PreparedPush {
  readonly argv: string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
  /** The environment of the remote check (the exec one, with the same `PATH`). */
  readonly readEnv: Record<string, string>;
}

/**
 * Validates a `push` message and returns what to spawn as a terminal, or a refusal code. The environment is the exec one (the
 * startup environment, PTY-5 clean, plus the message's allow-listed names; anything else is `env_denied`), with the transport
 * list replaced by exactly the push transports, prompts off and the `PATH` of `pushPath`. Its configuration and ssh variables
 * (`PUSH_ENV_NAMES`) must equal the ones the host validated (`expectEnv`), else `env_denied`.
 */
export function preparePush(m: PushMsg, cfg: PushRunConfig, platform: NodeJS.Platform): PreparedPush | { code: SpawnFailCode } {
  const { gitDir, workTree } = m.repo;
  if (!isAbsolutePath(gitDir, platform) || !isAbsolutePath(workTree, platform) || hasNul(gitDir) || hasNul(workTree)) return { code: "bad_argv" };
  if (!PUSH_REMOTE.test(m.remote) || !PUSH_REFSPEC.test(m.refspec)) return { code: "bad_argv" };
  const env = buildExecEnv(cfg.baseEnv, m.env, undefined);
  const readEnv = buildExecEnv(cfg.baseEnv, {}, undefined);
  if (env === undefined || readEnv === undefined) return { code: "env_denied" };
  for (const name of PUSH_ENV_NAMES) {
    // Exactly the spelling git reads; a value the base holds under another case is not what git sees.
    const have = Object.hasOwn(env, name) ? env[name] : undefined;
    if ((have ?? null) !== m.expectEnv[name]) return { code: "env_denied" };
  }
  keepGitNames(env);
  keepGitNames(readEnv);
  const path = pushPath(env["PATH"], [workTree, gitDir], platform);
  put(env, "PATH", path);
  put(readEnv, "PATH", path);
  put(env, "GIT_ALLOW_PROTOCOL", PUSH_TRANSPORTS.join(":"));
  put(env, "GIT_TERMINAL_PROMPT", "0");
  return { argv: pushArgv(cfg, m.repo, m.remote, m.refspec), cwd: workTree, env, readEnv };
}

/**
 * A push URL git can reach without a helper, by git's own grammar (`is_urlschemechar`: the first character alphanumeric, then also
 * `+`, `.`, `-`): no `<transport>::` form, and a scheme (when written) that is one of the push transports, compared case-sensitively
 * as git does (`HTTPS://` makes git look for a helper named `HTTPS`).
 */
export function pushUrlAllowed(url: string): boolean {
  if (url === "" || /^[A-Za-z0-9][A-Za-z0-9+.-]*::/.test(url)) return false;
  const scheme = /^([A-Za-z0-9][A-Za-z0-9+.-]*):\/\//.exec(url)?.[1];
  return scheme === undefined || (PUSH_TRANSPORTS as readonly string[]).includes(scheme);
}

/** git-ops' `pushUrlsDigest`: SHA-256 of the JSON of the trimmed, non-empty lines, sorted. */
export function pushUrlsDigest(lines: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(lines.map((l) => l.trim()).filter((l) => l !== "").sort())).digest("hex");
}

/**
 * The service's own check of the remote, just before the spawn (it trusts the daemon for which repository, R-H3, not for what
 * its configuration starts): `remote.<r>.vcs` must be unset (a helper named there runs `git remote-<vcs>`: a `git-remote-<vcs>`
 * on PATH or in the exec path, or an alias), and every push URL git resolves (`pushurl`, `insteadOf` and `pushInsteadOf`
 * applied) must pass `pushUrlAllowed` and hash to `expectUrls` (the digest git-ops read under the mutex: a URL changed since, a user-level
 * `pushInsteadOf` included, refuses). Both reads start nothing; each is bounded by `timeoutMs` (3 s, under the host's 10 s spawn bound). Anything else, a timeout or a failed start is a refusal. Each
 * read is in `running` while it runs, so the caller can kill it when its channel closes.
 */
export async function vetPushRemote(cfg: PushRunConfig, clock: Clock, repo: { gitDir: string; workTree: string }, remote: string, expectUrls: string, env: Record<string, string>, running: Set<ExecChild>, timeoutMs = 3_000): Promise<true | "remote_refused" | "spawn_failed"> {
  const read = (sub: string, args: readonly string[]): Promise<{ code: number | null; stdout: string } | "failed"> => {
    let child: ExecChild;
    try {
      child = cfg.exec({ argv: [cfg.gitPath, ...plainPrefix(repo, cfg.hooksOff, sub, false), sub, ...args], cwd: repo.workTree, env, maxOutput: 64 * 1024 });
    } catch {
      return Promise.resolve("failed");
    }
    running.add(child);
    return new Promise((done) => {
      const timer = clock.setTimeout(() => (child.kill(), done("failed")), timeoutMs);
      child.done
        .then(
          (o) => done(o.truncated ? "failed" : { code: o.code, stdout: Buffer.from(o.stdout).toString("utf8") }),
          () => done("failed"),
        )
        .finally(() => (clock.clearTimeout(timer), running.delete(child)));
    });
  };
  const vcs = await read("config", ["--get-all", `remote.${remote}.vcs`]);
  if (vcs === "failed") return "spawn_failed";
  if (vcs.code !== 1 || vcs.stdout !== "") return "remote_refused";
  const urls = await read("remote", ["get-url", "--push", "--all", "--", remote]);
  if (urls === "failed") return "spawn_failed";
  const list = urls.stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  if (urls.code !== 0 || list.length === 0 || !list.every(pushUrlAllowed) || pushUrlsDigest(list) !== expectUrls) return "remote_refused";
  return true;
}
