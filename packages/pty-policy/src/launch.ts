// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Launch rules for a CLI agent run (ADR 0004 decision 8; threat model TRU-2, PTY-5, PTY-6).
import { isAbsolute as posixAbs, normalize as posixNorm } from "node:path/posix";
import { isAbsolute as winAbs, normalize as winNorm } from "node:path/win32";
import { cliAgentSchema, type CliAgent } from "./agent.js";
import { buildCliEnv, type EnvLike, type Removal } from "./env.js";

export type LaunchRefusal = "UNTRUSTED" | "BAD_WORKTREE" | "INVALID_AGENT";

export type LaunchResult =
  | {
      readonly ok: true;
      /** argv[0] is the executable, resolved on PATH by the pty process. Never a shell string. */
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
  readonly platform?: NodeJS.Platform;
}

function cleanRoot(root: string, platform: NodeJS.Platform): boolean {
  if (root.includes("\0") || root.length === 0) return false;
  const abs = platform === "win32" ? winAbs(root) : posixAbs(root);
  if (!abs) return false;
  const norm = platform === "win32" ? winNorm(root) : posixNorm(root);
  // Reject '..' or '.' segments and doubled separators: the value must already be normalised.
  const trimmed = (s: string): string => s.replace(/[\\/]+$/, "");
  return trimmed(norm) === trimmed(root);
}

export function resolveLaunch(input: LaunchInput): LaunchResult {
  const platform = input.platform ?? process.platform;
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
  if (!cleanRoot(input.worktreeRoot, platform)) {
    return { ok: false, code: "BAD_WORKTREE", message: "The worktree root must be a normalised absolute path." };
  }
  const agent: CliAgent = parsed.data;
  const { env, removed } = buildCliEnv(input.parentEnv, {
    platform,
    envPassthrough: agent.envPassthrough,
    ...(input.extensionVariableNames ? { extensionVariableNames: input.extensionVariableNames } : {}),
  });
  return {
    ok: true,
    argv: [...agent.command, ...agent.args],
    cwd: input.worktreeRoot,
    env,
    removed,
    shellIntegration: false,
  };
}
