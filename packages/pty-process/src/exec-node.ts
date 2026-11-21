// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// PV-X1a (docs/design/pty-exec-node.md): the pty process's one production exec function. The only file of this package that loads
// node:child_process (scripts/code-oss/egress-rules.mjs SPAWN_FILES, ADR 0005 D3): the program is one of the absolute paths fixed
// at construction, compared here, before the call, as an exact string.
import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { signalGroup, validPgid } from "./group.js";
import { ExecStartError, systemProcessOps, type ExecChild, type ExecFn, type ExecOutcome, type ExecRequest } from "./ports.js";

const capOf = (n: unknown): number | undefined => (typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : undefined);

function startFailure(e: unknown): ExecStartError {
  const code = typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined;
  if (code === "ENOENT") return new ExecStartError("not_found");
  if (code === "EACCES" || code === "EPERM") return new ExecStartError("not_permitted");
  return new ExecStartError("start_failed");
}

/** SIGKILL to the whole group, after a probe (a reused pgid of a finished group is never hit blind). Never throws. */
function killGroup(pid: number | undefined): void {
  if (!validPgid(pid)) return;
  try {
    signalGroup(systemProcessOps, pid, "SIGKILL");
  } catch {
    /* unknown: nothing more this process can do */
  }
}

/** Keeps at most `cap` bytes of a stream and keeps reading past it, so a flood is never held and never blocks the child. */
function collector(stream: NodeJS.ReadableStream, cap: number): { readonly bytes: () => Buffer; readonly cut: () => boolean } {
  const parts: Buffer[] = [];
  let held = 0;
  let cut = false;
  stream.on("data", (chunk: Buffer) => {
    const room = cap - held;
    if (chunk.length > room) cut = true;
    if (room > 0) {
      const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
      parts.push(kept);
      held += kept.length;
    }
  });
  stream.on("error", () => undefined);
  return { bytes: () => Buffer.concat(parts), cut: () => cut };
}

/**
 * The exec function for one consumer. `programs` holds the absolute paths it may start (the git path for git, the gh path for
 * `forge-list`: one instance per consumer, so one consumer's bug cannot start the other's program).
 *
 * - `argv[0]` must equal a member exactly (no prefix, no case folding, no normalisation), or it throws `program_refused` before
 *   anything starts. On Windows it throws `unsupported_platform` (no process group; the job-object kill is PV-X1w).
 * - `shell: false`, its own process group (`detached`), no window, three pipes; the environment and cwd exactly as given.
 * - stdin is written with the request's bytes, if any, and ended at once.
 * - Each stream is held up to its own cap (`maxOutput`; stderr `maxStderr`, default `maxOutput`) and read to the end.
 * - A start that fails after the call rejects `done` with `not_found`, `not_permitted` or `start_failed`.
 * - `done` settles only after the leader exited, both pipes closed, and the group was then sent SIGKILL: no member of the group
 *   outlives a settled `done`. `kill()` SIGKILLs the group at once; `done` still settles by the same path.
 */
export function createNodeExec(programs: ReadonlySet<string>, platform: NodeJS.Platform): ExecFn {
  const allowed = new Set<string>();
  for (const p of programs) {
    if (typeof p !== "string" || p === "" || !isAbsolute(p) || p.includes("\0")) throw new ExecStartError("program_refused");
    allowed.add(p);
  }
  return (req: ExecRequest): ExecChild => {
    if (platform === "win32") throw new ExecStartError("unsupported_platform");
    const program = req.argv[0];
    if (typeof program !== "string" || !allowed.has(program)) throw new ExecStartError("program_refused");
    const maxOut = capOf(req.maxOutput);
    const maxErr = req.maxStderr === undefined ? maxOut : capOf(req.maxStderr);
    if (maxOut === undefined || maxErr === undefined) throw new ExecStartError("start_failed");
    let cp: ReturnType<typeof spawn>;
    try {
      cp = spawn(program, [...req.argv.slice(1)], {
        cwd: req.cwd,
        env: { ...req.env },
        shell: false,
        detached: true,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      throw startFailure(e);
    }
    const { stdin, stdout, stderr } = cp;
    if (stdin === null || stdout === null || stderr === null) {
      killGroup(cp.pid);
      throw new ExecStartError("start_failed");
    }
    const out = collector(stdout, maxOut);
    const err = collector(stderr, maxErr);
    const done = new Promise<ExecOutcome>((resolve, reject) => {
      let settled = false;
      cp.once("error", (e) => {
        if (settled) return;
        settled = true;
        killGroup(cp.pid);
        reject(startFailure(e));
      });
      cp.once("close", (code, signal) => {
        if (settled) return;
        settled = true;
        killGroup(cp.pid);
        const stdoutTruncated = out.cut();
        const stderrTruncated = err.cut();
        resolve({ code, signal, stdout: out.bytes(), stderr: err.bytes(), truncated: stdoutTruncated || stderrTruncated, stdoutTruncated, stderrTruncated });
      });
    });
    stdin.on("error", () => undefined);
    stdin.end(req.stdin === undefined ? undefined : Buffer.from(req.stdin));
    return { done, kill: () => killGroup(cp.pid) };
  };
}
