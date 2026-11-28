// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// TEST ONLY (audit C M1): the file the shell forks as the pty process, in the shape `src/signal-guard.ts` requires (the shell's
// file is OS-3's, which adds node-pty), with a marker once the guard is in place and a spawn that refuses instead of node-pty.
// Its one static import is the guard; the entry comes after, by `import()`, and gets the real process objects.
import "../src/signal-guard.js";

process.stderr.write("guarded\n");
const { runPtyEntry } = await import("../src/entry.js");
type Deps = Parameters<typeof runPtyEntry>[0];
runPtyEntry({
  parentPort: (process as unknown as { parentPort?: Deps["parentPort"] }).parentPort,
  process: process as unknown as Deps["process"],
  env: { ...process.env },
  execArgv: process.execArgv,
  platform: process.platform,
  spawn: (() => {
    throw new Error("no terminal in this test");
  }) as never,
  stderr: (line) => void process.stderr.write(`${line}\n`),
});
