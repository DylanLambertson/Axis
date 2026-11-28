// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// TEST ONLY (audit C M1): the file main forks as the daemon, in the shape `src/signal-guard.ts` requires (the shell's file is
// OS-3's), with a marker once the guard is in place. Its one static import is the guard; the entry comes after, by `import()`,
// and gets the real process objects, as the legacy overlay entry gave them.
import "../src/signal-guard.js";

process.stderr.write("guarded\n");
const { runDaemonEntry } = await import("../src/entry.js");
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
