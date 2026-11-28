// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The daemon's entry, bundled as dist/app/daemon-entry.cjs and loaded by daemon.cjs only after its SIGUSR1 guard is installed
// (OS-3.1). It hands the real process objects to the entry logic in @axis/daemon-host, which is tested without Electron.
import { runDaemonEntry } from "@axis/daemon-host/entry";

type Deps = Parameters<typeof runDaemonEntry>[0];
runDaemonEntry({
  parentPort: (process as unknown as { parentPort?: Deps["parentPort"] }).parentPort,
  process: process as unknown as Deps["process"],
  env: { ...process.env },
  cwd: process.cwd(),
  platform: process.platform,
  execArgv: process.execArgv,
  stderr: (line) => void process.stderr.write(`${line}\n`),
});
