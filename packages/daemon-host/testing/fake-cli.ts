// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The "fake CLI" of the headless slice (plan section 1.1): launched by the fake pty with the exact argv and environment the run
// supervisor built through `@axis/pty-policy`. It writes `src/hello.txt` in its working directory, dumps the NAMES of its
// environment (never the values) to the file named by its first argument, and exits 0. With `slow` as the second argument it
// then waits until it is killed, or until its stdin closes (the host died), so no test leaves a process behind.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [dumpPath, mode, releasePath] = process.argv.slice(2);
mkdirSync(join(process.cwd(), "src"), { recursive: true });
writeFileSync(join(process.cwd(), "src", "hello.txt"), "hello from the fake CLI\n");
if (dumpPath !== undefined) {
  writeFileSync(dumpPath, JSON.stringify({ pid: process.pid, cwd: process.cwd(), envNames: Object.keys(process.env).sort() }));
}
if (mode === "until-file" && releasePath !== undefined) {
  // Exits (0) once the test creates the file: the test, not a timer, decides when the run ends.
  setInterval(() => existsSync(releasePath) && process.exit(0), 10);
  for (const e of ["end", "close", "error"] as const) process.stdin.on(e, () => process.exit(0)); // the host died: do not poll forever
  process.stdin.resume();
} else if (mode === "slow") {
  process.stdin.on("end", () => process.exit(0));
  process.stdin.on("close", () => process.exit(0));
  process.stdin.on("error", () => process.exit(0));
  process.stdin.resume();
  setInterval(() => undefined, 1 << 30);
} else {
  process.exit(0);
}
