// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The pty process's entry, bundled as dist/app/pty-entry.cjs and loaded by pty.cjs only after its SIGUSR1 guard is installed
// (OS-3.1). The terminal backend is OS-3p: until it lands every spawn REFUSES ("no terminal backend"), which the entry answers as
// a failed spawn (fail closed). The daemon needs only this process's control hand-over to reach ready.
import { runPtyEntry } from "@axis/pty-process";

type Deps = Parameters<typeof runPtyEntry>[0];
runPtyEntry({
  parentPort: (process as unknown as { parentPort?: Deps["parentPort"] }).parentPort,
  process: process as unknown as Deps["process"],
  env: { ...process.env },
  execArgv: process.execArgv,
  platform: process.platform,
  spawn: (() => {
    throw new Error("no terminal backend");
  }) as Deps["spawn"],
  stderr: (line) => void process.stderr.write(`${line}\n`),
});
