// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// H9-hooks slice S4 part 1: `git push` as a terminal-bound run (docs/design/daemon-host-hooks.md §5.2,
// docs/design/daemon-host-hooks-s4.md). The service builds the whole argv and environment itself from closed fields; the
// message names a repository, a configured remote and the one pinned refspec, and nothing else.
import { buildExecEnv } from "./exec-env.js";
import type { ControlReply, ControlRequest } from "./messages.js";
import { hasNul, isAbsolutePath } from "./paths.js";

/** A configured remote name (git-ops' `REMOTE_NAME`): never a URL, a path or an option. */
export const PUSH_REMOTE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/**
 * The one refspec Axis pushes (git-ops' `isAllowedRefspec`): a full object id into `refs/heads/axis/<slug>`. No `+` (force),
 * no wildcard, no tag, no delete, no other namespace.
 */
export const PUSH_REFSPEC = /^(?:[0-9a-f]{40}|[0-9a-f]{64}):refs\/heads\/axis\/[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
/** The transports a push may use (git-ops' `PUSH_PROTOCOLS`), as the `GIT_ALLOW_PROTOCOL` list. */
export const PUSH_TRANSPORTS = ["https", "ssh", "git", "file"] as const;

type PushMsg = Extract<ControlRequest, { t: "push" }>;
type SpawnFailCode = Extract<ControlReply, { t: "spawn-failed" }>["code"];

export interface PushRunConfig {
  readonly gitPath: string;
  readonly hooksOff: string;
  readonly baseEnv: Readonly<Record<string, string | undefined>>;
}

/**
 * The argv of a push. The pins are those of every plain exec (hooks off, fsmonitor empty, no transport but the listed ones, no
 * autocorrect onto an alias) plus the per-transport allows; then a push that follows no tags, recurses into no submodule and
 * runs no hook (`--no-verify` as well as the hooks pin: part 1 runs no `pre-push`).
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
    "push", "--no-follow-tags", "--no-recurse-submodules", "--no-verify",
    "--", remote, refspec,
  ];
}

/** Sets `name` (replacing any spelling of it in another case). */
function put(env: Record<string, string>, name: string, value: string): void {
  for (const k of Object.keys(env)) if (k.toUpperCase() === name) delete env[k];
  env[name] = value;
}

/**
 * Validates a `push` message and returns what to spawn as a terminal, or a refusal code. The environment is the exec one (the
 * startup environment, PTY-5 clean, plus the message's allow-listed names; anything else is `env_denied`), with the transport
 * list replaced by exactly the push transports (it overrides every `protocol.*` setting, so a repository cannot widen it) and
 * prompts off. The schema has already checked the remote and the refspec; they are checked again here, where the argv is built.
 */
export function preparePush(m: PushMsg, cfg: PushRunConfig, platform: NodeJS.Platform): { argv: string[]; cwd: string; env: Record<string, string> } | { code: SpawnFailCode } {
  const { gitDir, workTree } = m.repo;
  if (!isAbsolutePath(gitDir, platform) || !isAbsolutePath(workTree, platform) || hasNul(gitDir) || hasNul(workTree)) return { code: "bad_argv" };
  if (!PUSH_REMOTE.test(m.remote) || !PUSH_REFSPEC.test(m.refspec)) return { code: "bad_argv" };
  const env = buildExecEnv(cfg.baseEnv, m.env, undefined);
  if (env === undefined) return { code: "env_denied" };
  put(env, "GIT_ALLOW_PROTOCOL", PUSH_TRANSPORTS.join(":"));
  put(env, "GIT_TERMINAL_PROMPT", "0");
  return { argv: pushArgv(cfg, m.repo, m.remote, m.refspec), cwd: workTree, env };
}
