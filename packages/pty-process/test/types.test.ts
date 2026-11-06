// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { PtyHandle as RunsHandle, PtyPort as RunsPort, PtySpawn as RunsSpawn } from "@axis/runs";
import { test } from "node:test";
import type { PtyHandle, PtyPort, PtySpawn } from "../src/index.js";

// Compile-time only: the host's hand copy and the supervisor's port must stay assignable both ways, except for `groupAlive`,
// which the supervisor's own PtyHandle gains in the same change (its absence in the older shape is checked by the host binding).
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const spawnSame: Equal<PtySpawn, RunsSpawn> = true;
const handleToRuns: (h: PtyHandle) => RunsHandle = (h) => h;
const portToRuns: (p: PtyPort) => RunsPort = (p) => p;
const portFromRuns: (p: RunsPort) => PtyPort = (p) => p as unknown as PtyPort;

test("the pty-process port types are assignable to the runs port types", () => {
  void [spawnSame, handleToRuns, portToRuns, portFromRuns];
});
