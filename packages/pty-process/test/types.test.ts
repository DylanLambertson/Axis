// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { PtyHandle as RunsHandle, PtyPort as RunsPort, PtySpawn as RunsSpawn } from "@axis/runs";
import { test } from "node:test";
import type { PtyHandle, PtyPort, PtySpawn } from "../src/index.js";

// Compile-time only: our port and handle must stay assignable to the supervisor's, and the spawn spec must be identical. The
// other direction does not hold (the supervisor's handle has no `groupAlive`), and `@axis/daemon-host`'s PtyPort, which does
// require it, cannot be imported here: its comparison belongs to the entry that wires this package into the host.
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const spawnSame: Equal<PtySpawn, RunsSpawn> = true;
const handleToRuns: (h: PtyHandle) => RunsHandle = (h) => h;
const portToRuns: (p: PtyPort) => RunsPort = (p) => p;

test("the pty-process port types are assignable to the runs port types", () => {
  void [spawnSame, handleToRuns, portToRuns];
});
