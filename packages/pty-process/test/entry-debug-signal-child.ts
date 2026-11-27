// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// TEST ONLY (audit C M1): the pty entry in a real child Node process, on the real `process`, with a parent port that never sends
// anything. It prints `ready` once the entry ran, then stays alive until the parent kills it.
import { runPtyEntry } from "../src/index.js";

runPtyEntry({
  parentPort: { on: () => undefined, removeListener: () => undefined },
  process,
  env: {},
  execArgv: process.execArgv,
  spawn: (() => {
    throw new Error("no terminal in this test");
  }) as never,
  stderr: (l) => void process.stderr.write(`${l}\n`),
});
process.stderr.write("ready\n");
setInterval(() => undefined, 1_000);
