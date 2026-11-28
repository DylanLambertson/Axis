// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// TEST ONLY (audit C M1, the startup window): fork a file with no flag, send SIGUSR1 from the moment its guard is in place until
// it exits, while its module graph is still loading, and report what happened. Detected by Node's stderr line and by a TCP connect to 9229 (skipped when the port
// was already taken before the fork).
import { fork } from "node:child_process";
import { connect } from "node:net";
import { readFileSync } from "node:fs";

/** True when something accepts a TCP connection on 127.0.0.1:9229 within 1 s. */
export const inspectorPortOpen = (): Promise<boolean> =>
  new Promise((resolve) => {
    const sock = connect({ host: "127.0.0.1", port: 9229 });
    const done = (open: boolean): void => {
      sock.destroy();
      resolve(open);
    };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    sock.setTimeout(1_000, () => done(false));
  });

/** Node's stderr when SIGUSR1 starts the inspector ("Starting inspector ... failed" when the port is taken). */
export const INSPECTOR_LINE = /Debugger listening|Starting inspector/;

export interface SignalWindowResult {
  readonly err: string;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  /** SIGUSR1s delivered after the marker and before the exit. */
  readonly sent: number;
  /** True or false when the port was free before the fork; undefined when it was already taken. */
  readonly portOpenAfter: boolean | undefined;
}

/** The line a test child writes right after its signal guard is in place. */
export const GUARDED_LINE = "guarded\n";

/**
 * Forks `file` (no `execArgv`, no IPC parent port). Once it writes GUARDED_LINE, sends SIGUSR1 every `everyMs` until it exits
 * (at most 40), so every signal lands while the module graph loads; then waits for the exit.
 */
export async function signalDuringLoad(file: string, everyMs = 50): Promise<SignalWindowResult> {
  const portTaken = await inspectorPortOpen();
  const child = fork(file, [], { env: { PATH: process.env["PATH"] ?? "" }, execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let err = "";
  child.stderr?.on("data", (c: Buffer) => void (err += c.toString("utf8")));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  const alive = (): boolean => child.exitCode === null && child.signalCode === null;
  let sent = 0;
  let portOpenAfter: boolean | undefined;
  try {
    const deadline = Date.now() + 30_000;
    while (alive() && !err.includes(GUARDED_LINE) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    while (alive() && sent < 40) {
      try {
        process.kill(child.pid as number, "SIGUSR1");
        sent += 1;
      } catch {
        break; // already gone
      }
      await new Promise((r) => setTimeout(r, everyMs));
    }
    // The inspector, once open, stays open while the process lives: look before the exit.
    if (!portTaken && alive()) portOpenAfter = await inspectorPortOpen();
    const timeout = setTimeout(() => child.kill("SIGKILL"), 60_000);
    const end = await exited;
    clearTimeout(timeout);
    return { err, ...end, sent, portOpenAfter };
  } finally {
    if (alive()) child.kill("SIGKILL");
  }
}

/** The static `import` specifiers of a compiled ES module (`import "x"` and `import ... from "x"` at the start of a line). */
export function staticImports(jsFile: string): string[] {
  const text = readFileSync(jsFile, "utf8");
  return [...text.matchAll(/^\s*(?:import|export)\b[^;("']*?(?:from\s*)?["']([^"']+)["']/gm)].map((m) => m[1] as string);
}

/** The first statement of a compiled module, comments and blank lines skipped. */
export function firstStatement(jsFile: string): string {
  const text = readFileSync(jsFile, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const line = text.split("\n").map((l) => l.trim()).find((l) => l !== "" && !l.startsWith("//"));
  return line ?? "";
}
