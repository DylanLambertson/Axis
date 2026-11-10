// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Compile-time check that the host's exec port (src/ports/pty.ts) is the pty process's `exec` client, field for field: the
// host's src imports nothing of @axis/pty-process, so if either side drifts, `tsc` fails here.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { PtyExecCall as RealCall, PtyExecOutcome as RealOutcome, PtyProcessPort } from "@axis/pty-process";
import type { PtyExecCall, PtyExecOutcome, PtyExecPort } from "../../src/ports/pty.js";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const yes = <T extends true>(): T | undefined => undefined;

yes<Equal<PtyExecCall, RealCall>>();
yes<Equal<PtyExecOutcome, RealOutcome>>();
yes<Equal<Parameters<PtyExecPort["exec"]>, Parameters<PtyProcessPort["exec"]>>>();
yes<Equal<ReturnType<PtyExecPort["exec"]>, ReturnType<PtyProcessPort["exec"]>>>();

test("the host's exec port matches the pty process client (checked by the compiler)", () => {
  const port: PtyExecPort = {} as PtyProcessPort;
  assert.ok(port !== undefined);
});
