// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Audit C M1, the startup window: under Electron's utilityProcess `--disable-sigusr1` is not honoured, so the SIGUSR1 listener is
// the control, and the file main forks must install it before the daemon's module graph loads (about 1.2 s to 1.8 s), not after. That file is
// the shell's (OS-3); `testing/process-main-child.ts` has its required shape.
// The behavioural test starts signalling at the child's marker, so it catches neither a static entry import (which moves the
// marker past the graph load) nor a guard registered with `once` (the entry adds its own listener before the callback runs):
// only the pins below do. Do not drop them as redundant; the shell's forked file (OS-3) needs the same pins.
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { firstStatement, INSPECTOR_LINE, signalDuringLoad, staticImports } from "../testing/signal-window.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const GUARD = join(HERE, "..", "src", "signal-guard.js");
const CHILD = join(HERE, "..", "testing", "process-main-child.js");

test("the signal guard's first statement is the listener and it imports nothing; the forked file's one static import is the guard", () => {
  assert.deepEqual(staticImports(GUARD), []);
  assert.equal(firstStatement(GUARD), 'process.on("SIGUSR1", () => undefined);');
  assert.deepEqual(staticImports(CHILD), ["../src/signal-guard.js"]);
});

const SKIP = process.platform === "win32" ? "no SIGUSR1 on Windows (process._debugProcess: RR-83)" : false;

test("the forked file, sent SIGUSR1 without the flag from the moment its guard is in until it exits, opens no inspector and reaches the entry", { skip: SKIP }, async () => {
  // No parent port under plain Node, so the entry refuses (exit 78) once loaded; every signal came while the graph loaded.
  const r = await signalDuringLoad(CHILD);
  assert.ok(r.sent >= 1, `at least one signal landed in the window\n${r.err}`);
  assert.doesNotMatch(r.err, INSPECTOR_LINE, "no inspector was started");
  assert.notEqual(r.portOpenAfter, true, "nothing listened on 9229");
  assert.deepEqual({ code: r.code, signal: r.signal }, { code: 78, signal: null }, r.err);
  assert.match(r.err, /axis\.daemon refused to start: not_utility_process/);
});
