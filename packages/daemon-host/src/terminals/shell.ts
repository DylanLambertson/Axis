// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { constants, promises as fs } from "node:fs";
import { isAbsolute } from "node:path";

export interface ShellDeps {
  /** The daemon's own environment (only `SHELL` is read). */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  /** The text of `/etc/shells`. A throw lists nothing. */
  readonly readShells?: () => Promise<string>;
  /** The fallback shell. Default `/bin/sh`. */
  readonly fallback?: string;
}

/** True for an absolute path to an existing regular file this process may execute. Any failure is false. */
async function executableFile(p: string): Promise<boolean> {
  try {
    if (!(await fs.stat(p)).isFile()) return false;
    await fs.access(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * DC-3a (terminals-contract.md section 3): the plain terminal's shell, for now. `$SHELL` of the daemon's environment when it is an
 * absolute path, an existing regular file that is executable, and a whole line of `/etc/shells`; otherwise `/bin/sh` under the
 * same rule; otherwise `undefined` (`shell_unavailable`). Windows has none in this slice. Follow-up OS-4: a user-scope setting.
 */
export async function pickShell(deps: ShellDeps): Promise<string | undefined> {
  if (deps.platform === "win32") return undefined;
  let listed: ReadonlySet<string>;
  try {
    const text = await (deps.readShells ?? (() => fs.readFile("/etc/shells", "utf8")))();
    listed = new Set(
      text
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l !== "" && !l.startsWith("#")),
    );
  } catch {
    return undefined;
  }
  for (const candidate of [deps.env["SHELL"], deps.fallback ?? "/bin/sh"]) {
    if (typeof candidate !== "string" || candidate === "" || !isAbsolute(candidate) || !listed.has(candidate)) continue;
    if (await executableFile(candidate)) return candidate;
  }
  return undefined;
}
