// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// PV-K2 K2-g3: the composed host takes the journal's grant mint at startup, so no code can obtain it later.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { GitRunner } from "@axis/git-ops";
import { composeDaemonHost, type ComposeOptions, type PtyPort } from "../src/index.js";
import { hostFixture } from "../testing/host-fixture.js";
import { must } from "./helpers.js";

const pty: PtyPort = { spawn: () => Promise.reject(new Error("unused")) };
const runner: GitRunner = { run: () => Promise.reject(new Error("unused")) };
const snapshotter: NonNullable<ComposeOptions["snapshotter"]> = () => ({ before: () => Promise.resolve(), after: () => Promise.resolve({ drift: false }) });

test("after startup the composed host holds the grant mint: a later takeGrantMint throws", async () => {
  const fix = hostFixture();
  const { control: _control, ...ports } = fix.ports as typeof fix.ports & { control: unknown };
  const composed = composeDaemonHost({ config: fix.config, control: fix.client, ports, pty, ptyGitRunner: runner, snapshotter, process: new EventEmitter(), exit: () => undefined });
  try {
    const s = await composed.start();
    assert.equal(s.degraded, undefined);
    assert.throws(() => must(s.journal).plugins.takeGrantMint(), (e: unknown) => JSON.stringify((e as { detail?: unknown }).detail ?? {}).includes("mint_taken") || String((e as Error).message).includes("already taken"));
  } finally {
    await composed.stop();
    fix.cleanup();
  }
});

test("PV-M7 slice 2: after startup the composed host holds the CLI endpoint switch mint too: a later takeSwitchMint throws", async () => {
  const fix = hostFixture();
  const { control: _control, ...ports } = fix.ports as typeof fix.ports & { control: unknown };
  const composed = composeDaemonHost({ config: fix.config, control: fix.client, ports, pty, ptyGitRunner: runner, snapshotter, process: new EventEmitter(), exit: () => undefined });
  try {
    const s = await composed.start();
    assert.equal(s.degraded, undefined);
    assert.throws(() => must(s.journal).cliEndpoint.takeSwitchMint(), (e: unknown) => (e as { detail?: { reason?: string } }).detail?.reason === "mint_taken");
  } finally {
    await composed.stop();
    fix.cleanup();
  }
});
