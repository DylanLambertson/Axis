// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { GitRunner } from "@axis/git-ops";
import { composeDaemonHost, type ComposeOptions, type PtyPort } from "../src/index.js";
import { servingGitPortDeps } from "../src/compose-serving.js";
import { hostFixture } from "../testing/host-fixture.js";

// DC-0b: the composed host runs the stale index lock sweep at start, before anything is served. A lock the journal recorded
// as Axis's (and still the file recorded) is gone after a restart, and its record with it; a lock with no record stays.
// Mutants: the sweep not called at startup; the serving git port built without the journal's ledger (review 1 N2: DC-0b
// would then be off without a sound).

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
    const copy = join(root, "a", ".git", "index.axis-0123456789abcdef");
    const theirs = join(root, "b", ".git", "index.lock");
    for (const p of [ours, theirs]) {
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, "an index copy\n");
    }
    writeFileSync(copy, "a crashed refresh's copy\n");
    const first = compose();
    const s1 = await first.start();
    for (const [id, name] of [["pa", "a"], ["pb", "b"]] as const) s1.journal!.registerProject({ id, path: join(root, name), displayName: name, trusted: false, actor: "user" });
    const st = statSync(ours, { bigint: true });
    s1.journal!.indexLocks.record({ path: ours, dev: st.dev, ino: st.ino, ctimeNs: st.ctimeNs });
    const head = s1.audit!.head();
    await first.stop();
    fix.supervisor.anchor = head;
    const second = compose();
    const s2 = await second.start();
    try {
      assert.equal(s2.degraded, undefined);
      assert.equal(existsSync(ours), false, "kills a host that does not sweep at start");
      assert.equal(existsSync(theirs), true);
      assert.equal(existsSync(copy), false, "a registered repository's leftover copy goes too");
      assert.deepEqual(s2.journal!.indexLocks.list(), []);
    } finally {
      await second.stop();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    fix.cleanup();
  }
});

test("the serving git port gets the journal's own index lock ledger (kills dropping the wiring)", () => {
  const indexLocks = { record: () => undefined, clear: () => undefined };
  const runner: GitRunner = { run: () => Promise.reject(new Error("unused")) };
  const deps = servingGitPortDeps(
    { gitPath: "/usr/bin/git", excludeDirs: () => [] },
    { config: { platform: "linux" }, ports: { env: {} }, scanner: {}, ptyGitRunnerFor: () => runner, runHooks: false } as unknown as Parameters<typeof servingGitPortDeps>[1],
    { indexLocks },
    { assertNoDrift: () => Promise.resolve() },
  );
  assert.equal(deps.indexLockLedger, indexLocks);
});
