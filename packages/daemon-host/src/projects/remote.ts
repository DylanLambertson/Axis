// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { join } from "node:path";
import { daemonGitEnv, guardedRunner, prefix, type Env, type GitOpsDeps, type GitRunner } from "@axis/git-ops";
import { toDisplayPath } from "@axis/protocol";
import { nodeBindingFs, type BindingFs, type RepositoryBinding } from "./binding.js";

/**
 * The remote shown in main's "Add this repository" and "Trust to run" dialogs (docs/design/project-registration-and-trust.md
 * §5.3). The ONLY git call of an inspection, and display text only: nothing here fetches or decides anything.
 *
 * - Through `prefix()`, `daemonGitEnv` and `guardedRunner`, unchanged, so every daemon pin is on the call (hooks off,
 *   `core.fsmonitor=false`, `protocol.allow=never`, `protocol.ext.allow=never`, `commit.gpgsign=false`, `core.askPass=`,
 *   `diff.submodule=short`, `help.autocorrect=0`, `GIT_NO_LAZY_FETCH=1`, `GIT_ALLOW_PROTOCOL=/`), with the binding's explicit
 *   `--git-dir` and `--work-tree`.
 * - `config --file <P/.git/config> --no-includes`: that one file, never global or system config, never `include.path` or
 *   `includeIf`. It must be a regular file of at most 1 MiB before git opens it (a FIFO or `/dev/stdin` would hang git).
 * - 5 s, under the inspection's signal. Any failure is "unknown": the dialog still opens.
 * Not `daemonGitFor`: it reads the effective config (`filterNames`), includes and all, before the first call.
 */
export const REMOTE_TIMEOUT_MS = 5_000;
export const MAX_CONFIG_BYTES = 1_048_576;
export const MAX_REMOTE_URL_DISPLAY = 192;
const MAX_REMOTES = 64;

export interface RemoteSummary {
  /** `origin`, else the first remote in config order; null when there is none. */
  readonly remote: { readonly name: string; readonly url: string } | null;
  /** How many remotes have a URL (capped at 64). */
  readonly remotes: number;
}

export interface RemoteReaderDeps {
  readonly runner: GitRunner;
  /** The daemon's source environment (GIT-ENV-1): `daemonGitEnv` filters it and adds the pins. */
  readonly env: Env;
  readonly platform: NodeJS.Platform;
  /** Windows only (`core.hooksPath`). */
  readonly emptyHooksDir?: string;
  readonly fs?: BindingFs;
  readonly timeoutMs?: number;
}

/**
 * A URL as the dialog shows it: user info, query and fragment removed (an `scp`-like `user@host:path` loses `user@`), then escaped
 * and bounded by the display rules every Axis display field uses (`toDisplayPath`: control, format and bidirectional characters
 * escaped; at most 192 characters).
 */
export function displayRemoteUrl(raw: string): string {
  let s = raw;
  const url = /^([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^/?#]*)(.*)$/s.exec(s);
  if (url !== null) {
    const authority = url[2] as string;
    s = `${url[1]}${authority.slice(authority.lastIndexOf("@") + 1)}${url[3]}`;
  } else {
    const scp = /^[^/@:]+@([^/:]+:.*)$/s.exec(s);
    if (scp !== null) s = scp[1] as string;
  }
  return toDisplayPath(s.replace(/[?#].*$/s, ""), MAX_REMOTE_URL_DISPLAY);
}

/** Parses `config --null --get-regexp` output: `<key>\n<value>\0` per entry; keys are `remote.<name>.url`. */
export function parseRemotes(stdout: string): RemoteSummary {
  const found: { name: string; url: string }[] = [];
  for (const entry of stdout.split("\0")) {
    const nl = entry.indexOf("\n");
    if (nl < 0) continue;
    const key = entry.slice(0, nl);
    if (!key.startsWith("remote.") || !key.endsWith(".url") || key.length <= 11) continue;
    if (found.length < MAX_REMOTES) found.push({ name: key.slice(7, -4), url: entry.slice(nl + 1) });
  }
  const chosen = found.find((r) => r.name === "origin") ?? found[0];
  return {
    remote: chosen === undefined ? null : { name: toDisplayPath(chosen.name, 64), url: displayRemoteUrl(chosen.url) },
    remotes: found.length,
  };
}

/** Reads the remotes of a bound repository. `undefined` when they cannot be read safely (the dialog says "remote unknown"). */
export async function readRemote(binding: RepositoryBinding, deps: RemoteReaderDeps, signal?: AbortSignal): Promise<RemoteSummary | undefined> {
  const config = join(binding.commonDir, "config");
  try {
    const st = await (deps.fs ?? nodeBindingFs).lstat(config);
    if (st.isSymbolicLink() || !st.isFile() || BigInt(st.size) > BigInt(MAX_CONFIG_BYTES)) return undefined;
  } catch (e) {
    return (e as { code?: unknown } | null)?.code === "ENOENT" ? { remote: null, remotes: 0 } : undefined;
  }
  // Only what prefix(), hooksOffPath() and guardedRunner() read: the runner, the platform and the Windows hooks directory.
  const ops = { runner: deps.runner, platform: deps.platform, env: { daemon: deps.env, pty: {} }, ...(deps.emptyHooksDir === undefined ? {} : { emptyHooksDir: deps.emptyHooksDir }) } as unknown as GitOpsDeps;
  const bound = AbortSignal.timeout(deps.timeoutMs ?? REMOTE_TIMEOUT_MS);
  try {
    const w = { workTree: binding.path, gitDir: binding.commonDir };
    const r = await guardedRunner(deps.runner, ops).run({
      argv: [...prefix(w, ops, { context: "daemon", hooks: false, filters: [] }), "config", "--file", config, "--no-includes", "--null", "--get-regexp", "^remote\\..*\\.url$"],
      cwd: binding.path,
      env: daemonGitEnv(deps.env, deps.platform),
      context: "daemon",
      signal: signal === undefined ? bound : AbortSignal.any([signal, bound]),
      maxOutput: 65_536,
    });
    if (bound.aborted || signal?.aborted) return undefined;
    // git config exits 1 when no key matches.
    if (r.code === 1) return { remote: null, remotes: 0 };
    if (r.code !== 0 || r.truncated === true) return undefined;
    return parseRemotes(r.stdout);
  } catch {
    return undefined;
  }
}
