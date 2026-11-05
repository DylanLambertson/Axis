// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// PTY-4: the program a command will start, found and pinned when the policy decides and checked again when it runs.
import { resolveExecutable, nodeFs } from "@axis/pty-policy";
import { BrokerError, denied, invalid } from "./errors.js";
import type { BrokerFs } from "./fs.js";
import { isUnder } from "./contain.js";
import type { Env } from "./types.js";

/** A file at a moment: `dev:ino`, size and both times. A rename over it, a copy in its place or an in-place edit all change it. */
export interface FileIdentity {
  readonly real: string;
  readonly identity: string;
}

/** `exe` is what is started; `real` is its real path. Everything here is compared at the time of use. */
export interface PinnedProgram extends FileIdentity {
  readonly exe: string;
  /** The `#!` interpreter of a script, pinned the same way: the script's own name says nothing about what runs it. */
  readonly interpreter?: FileIdentity;
}

type Deps = { readonly fs: BrokerFs; readonly platform: NodeJS.Platform };

async function identify(d: Deps, path: string): Promise<FileIdentity> {
  const real = await d.fs.realpath(path).catch(() => {
    throw new BrokerError("E_NOT_FOUND", "unresolved-command", "the command was not found");
  });
  const st = await d.fs.lstat(real).catch(() => {
    throw new BrokerError("E_NOT_FOUND", "unresolved-command", "the command was not found");
  });
  if (st.kind !== "file") throw new BrokerError("E_NOT_FOUND", "unresolved-command", "the command is not a file");
  return { real, identity: [st.id, st.size, st.mtime, st.ctime].join(":") };
}

/** The interpreter a `#!` line names, or undefined for a binary. */
async function shebang(d: Deps, real: string): Promise<string | undefined> {
  let head: Buffer;
  try {
    const f = await d.fs.open(real, "read");
    try {
      head = await f.read(256);
    } finally {
      await f.close();
    }
  } catch {
    return undefined;
  }
  if (head.length < 2 || head[0] !== 0x23 || head[1] !== 0x21) return undefined;
  return /^#!\s*(\S+)/.exec(head.toString("latin1"))?.[1];
}

/**
 * Resolves `command` the way `ctx.run` will: an absolute path is judged by its real path, a bare name is searched on
 * the tool's PATH outside the worktree and every repository. Never a program that lives inside the tree.
 */
export async function pinProgram(d: Deps, command: unknown, env: Env, exclude: readonly string[]): Promise<PinnedProgram> {
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
  const self = await identify(d, exe);
  const line = await shebang(d, self.real);
  if (line === undefined) return { exe, ...self };
  if (!/^[A-Za-z]:[\\/]|^\//.test(line)) throw denied("unresolved-command", "the script's interpreter is not an absolute path");
  return { exe, ...self, interpreter: await identify(d, line) };
}
