// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
//
// Mutation run for the audit C M1 startup window: the signal guard each forked file imports first (the forked files are the
// shell's; the tests' children have their shape).
//
//   npm run build && node scripts/mutation/startup-signal.mjs "$PWD"
//
// Each mutant edits ONE compiled file under dist, runs the tests that must catch it, and restores the file (run.mjs). Not part
// of the gate: run it after a change to these files and state the result.
import { runMutants } from "./run.mjs";
const root = process.argv[2];
const D = `${root}/packages/daemon-host/dist`;
const P = `${root}/packages/pty-process/dist`;
const F = { dg: `${D}/src/signal-guard.js`, pg: `${P}/src/signal-guard.js` };
const DT = [`${D}/test/process-main.test.js`];
const PT = [`${P}/test/process-main.test.js`];
const T = { dg: DT, pg: PT };
const GUARD = 'process.on("SIGUSR1", () => undefined);';
const M = [
  ["dg", "daemon guard listens for nothing", GUARD, ""],
  ["dg", "daemon guard listens for another signal", GUARD, 'process.on("SIGUSR2", () => undefined);'],
  ["dg", "daemon guard waits for the next turn", GUARD, 'setImmediate(() => process.on("SIGUSR1", () => undefined));'],
  ["dg", "daemon guard imports something first", GUARD, `import "node:os";\n${GUARD}`],
  ["pg", "pty guard listens for nothing", GUARD, ""],
  ["pg", "pty guard listens for another signal", GUARD, 'process.on("SIGUSR2", () => undefined);'],
  ["pg", "pty guard waits for the next turn", GUARD, 'setImmediate(() => process.on("SIGUSR1", () => undefined));'],
  ["pg", "pty guard imports something first", GUARD, `import "node:os";\n${GUARD}`],
];
runMutants({ root, files: F, tests: T, mutants: M });
