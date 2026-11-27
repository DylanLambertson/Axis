// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { GitRunner } from "@axis/git-ops";
import { composeDaemonHost, type ComposeOptions, type PtyPort } from "../src/index.js";
import { hostFixture } from "../testing/host-fixture.js";

// DC-0b: the composed host runs the stale index lock sweep at start, before anything is served. A lock the journal recorded
// as Axis's (and still the file recorded) is gone after a restart, and its record with it; a lock with no record stays.
// Mutant: the sweep not called at startup.

const pty: PtyPort = { spawn: () => Promise.reject(new Error("unused")) };
const runner: GitRunner = { run: () => Promise.reject(new Error("unused")) };
const snapshotter: NonNullable<ComposeOptions["snapshotter"]> = () => ({ before: () => Promise.resolve(), after: () => Promise.resolve({ drift: false }) });

test("host start removes a recorded crash lock and keeps an unrecorded one", async () => {
  const fix = hostFixture();
  const root = mkdtempSync(join(process.env["TMPDIR"] ?? "/tmp", "axis-sweep-host-"));
  const compose = () => {
    const { control: _control, ...ports } = fix.ports as typeof fix.ports & { control: unknown };
    return composeDaemonHost({ config: fix.config, control: fix.client, ports, pty, ptyGitRunner: runner, snapshotter, process: new EventEmitter(), exit: () => undefined });
  };
  try {
    const ours = join(root, "a", ".git", "index.lock");
    const theirs = join(root, "b", ".git", "index.lock");
    for (const p of [ours, theirs]) {
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, "an index copy\n");
    }
    const first = compose();
    const s1 = await first.start();
    const st = statSync(ours, { bigint: true });
    s1.journal!.indexLocks.record({ path: ours, dev: st.dev, ino: st.ino, mtimeNs: st.mtimeNs });
    const head = s1.audit!.head();
    await first.stop();
    fix.supervisor.anchor = head;
    const second = compose();
    const s2 = await second.start();
    try {
      assert.equal(s2.degraded, undefined);
      assert.equal(existsSync(ours), false, "kills a host that does not sweep at start");
      assert.equal(existsSync(theirs), true);
      assert.deepEqual(s2.journal!.indexLocks.list(), []);
    } finally {
      await second.stop();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    fix.cleanup();
  }
});
