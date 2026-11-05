// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// PTY-4: the program a command will start, found and pinned when the policy decides and checked again when it runs.
import { resolveExecutable, nodeFs } from "@axis/pty-policy";
import { BrokerError, denied, invalid } from "./errors.js";
import type { BrokerFs } from "./fs.js";
import { isUnder } from "./contain.js";
import type { Env } from "./types.js";

/** `exe` is what is started; `real` is its real path. Both are compared at the time of use. */
export interface PinnedProgram {
  readonly exe: string;
  readonly real: string;
}

/**
 * Resolves `command` the way `ctx.run` will: an absolute path is judged by its real path, a bare name is searched on
 * the tool's PATH outside the worktree and every repository. Never a program that lives inside the tree.
 */
export async function pinProgram(d: { readonly fs: BrokerFs; readonly platform: NodeJS.Platform }, command: unknown, env: Env, exclude: readonly string[]): Promise<PinnedProgram> {
  if (typeof command !== "string") throw invalid("invalid-command", "the command is not valid");
  let exe: string;
  if (/^[A-Za-z]:[\\/]|^\//.test(command)) {
    const realExe = await d.fs.realpath(command).catch(() => {
      throw new BrokerError("E_NOT_FOUND", "unresolved-command", "the command was not found");
    });
    if (exclude.some((x) => isUnder(realExe, x, d.platform) || isUnder(command, x, d.platform))) throw denied("unresolved-command", "the command is inside the worktree");
    exe = realExe;
  } else {
    const found = resolveExecutable(command, env, d.platform, nodeFs, { excludeDirs: exclude });
    if (found === undefined) throw new BrokerError("E_NOT_FOUND", "unresolved-command", "the command was not found on PATH");
    exe = found;
  }
  // A bare name can resolve to a symlink to a shell: the real path is what is judged.
  const real = await d.fs.realpath(exe).catch(() => exe);
  return { exe, real };
}
