// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Launch rules for a CLI agent run (ADR 0004 decision 8; threat model TRU-2, PTY-5, PTY-6).
import { cliAgentSchema, type CliAgent } from "./agent.js";
import { buildCliEnv, type EnvLike, type Removal } from "./env.js";
import { checkExecutable, nodeFs, resolveExecutable, type ExecFs } from "./exec.js";
import { hasDotDot, isInside, isNormalised, isPlainAbsolute } from "./paths.js";

export type LaunchRefusal = "UNTRUSTED" | "BAD_WORKTREE" | "INVALID_AGENT" | "EXECUTABLE_NOT_FOUND";

export type LaunchResult =
  | {
      readonly ok: true;
      /** argv[0] is the absolute path Axis resolved. The pty never searches PATH or the cwd. */
      readonly argv: readonly string[];
      readonly cwd: string;
      readonly env: Record<string, string>;
      readonly removed: readonly Removal[];
      /** CLI runs always have shell integration off and no nonce. */
      readonly shellIntegration: false;
    }
  | { readonly ok: false; readonly code: LaunchRefusal; readonly message: string };

export interface LaunchInput {
  readonly agent: unknown;
  /** Canonical absolute worktree root from the journal (the daemon realpath-checks it before calling). */
  readonly worktreeRoot: string;
  /** Must be exactly true. Anything else, including undefined, refuses. */
  readonly trusted: boolean;
  readonly parentEnv: EnvLike;
  readonly extensionVariableNames?: readonly string[];
  /** Defaults to process.platform; injectable for tests. */
  readonly platform?: NodeJS.Platform;
  /** File system probe for executable resolution. Defaults to node:fs. */
  readonly fs?: ExecFs;
  readonly shellIntegrationDir?: string;
}

function cleanRoot(root: string, platform: NodeJS.Platform): boolean {
  return isPlainAbsolute(root, platform) && isNormalised(root, platform) && !hasDotDot(root);
}

export function resolveLaunch(input: LaunchInput): LaunchResult {
  const platform = input.platform ?? process.platform;
  const fs = input.fs ?? nodeFs;
  if (input.trusted !== true) {
    return {
      ok: false,
      code: "UNTRUSTED",
      message: "The source repository is not trusted. Trust it to run agents in this workspace.",
    };
  }
  const parsed = cliAgentSchema.safeParse(input.agent);
  if (!parsed.success) {
    return { ok: false, code: "INVALID_AGENT", message: parsed.error.issues[0]?.message ?? "Invalid agent definition." };
  }
  const agent: CliAgent = parsed.data;
  const command0 = agent.command[0] as string;
  const reason = checkExecutable(command0, platform);
  if (reason) return { ok: false, code: "INVALID_AGENT", message: reason };
  if (typeof input.worktreeRoot !== "string" || !cleanRoot(input.worktreeRoot, platform)) {
    return { ok: false, code: "BAD_WORKTREE", message: "The worktree root must be a normalised absolute path." };
  }

  const bare = !isPlainAbsolute(command0, platform);
  let file: string | undefined;
  if (bare) {
    file = resolveExecutable(command0, input.parentEnv, platform, fs, { excludeDirs: [input.worktreeRoot] });
  } else if (!isInside(command0, input.worktreeRoot, platform) && fs.isExecutableFile(command0)) {
    file = command0;
  }
  if (file === undefined) {
    return {
      ok: false,
      code: "EXECUTABLE_NOT_FOUND",
      message: bare
        ? `'${command0}' was not found on PATH outside the worktree.`
        : "The command is not an executable file, or it lies inside the worktree.",
    };
  }

  const { env, removed } = buildCliEnv(input.parentEnv, {
    platform,
    envPassthrough: agent.envPassthrough,
    ...(input.extensionVariableNames ? { extensionVariableNames: input.extensionVariableNames } : {}),
    ...(input.shellIntegrationDir ? { shellIntegrationDir: input.shellIntegrationDir } : {}),
  });
  return {
    ok: true,
    argv: [file, ...agent.command.slice(1), ...agent.args],
    cwd: input.worktreeRoot,
    env,
    removed,
    shellIntegration: false,
  };
}
