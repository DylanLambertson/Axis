// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// `@axis/pty-process/config` (PV-X1b, docs/design/pty-exec-node.md §5 and §6.2): the names main hands the programs and the scratch
// directory over in, and the check the pty entry applies to them. Main imports this subpath to check its own resolution before the
// fork (§6.2). It holds no exec function, service or spawn adapter and imports only `node:fs` and `node:path`
// (test/packages/pty-config-subpath.test.mjs), so a main-side importer never reaches code that starts a program.
import { accessSync, constants, lstatSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

/** The names main hands the programs and the scratch directory over in (§6.2). */
export const PTY_ENV_GIT = "AXIS_PTY_GIT";
export const PTY_ENV_GH = "AXIS_PTY_GH";
export const PTY_ENV_SCRATCH = "AXIS_PTY_SCRATCH";

/** The exec configuration the entry read from its environment, or the closed reason it refuses. */
export interface PtyExecConfig {
  readonly gitPath?: string;
  readonly ghPath?: string;
  readonly scratchParent?: string;
}

const programOk = (p: string): boolean => {
  if (!isAbsolute(p) || p.includes("\0")) return false;
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const scratchOk = (p: string): boolean => {
  if (!isAbsolute(p) || p.includes("\0")) return false;
  try {
    const st = lstatSync(p);
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    return st.isDirectory() && (st.mode & 0o077) === 0 && (uid === undefined || st.uid === uid);
  } catch {
    return false;
  }
};

/** Reads and checks the hand-over names. Unset names stay unset; a set name that fails its check is a refusal reason. */
export function readPtyExecConfig(env: Readonly<Record<string, string | undefined>>): PtyExecConfig | string {
  const git = env[PTY_ENV_GIT];
  const gh = env[PTY_ENV_GH];
  const scratch = env[PTY_ENV_SCRATCH];
  if (git !== undefined && !programOk(git)) return "git_path_refused";
  if (gh !== undefined && !programOk(gh)) return "gh_path_refused";
  if (scratch !== undefined && !scratchOk(scratch)) return "scratch_refused";
  if (git !== undefined && scratch === undefined) return "scratch_refused";
  return { ...(git === undefined ? {} : { gitPath: git }), ...(gh === undefined ? {} : { ghPath: gh }), ...(scratch === undefined ? {} : { scratchParent: scratch }) };
}
