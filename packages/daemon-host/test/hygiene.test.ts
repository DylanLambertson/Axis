// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
// The scaffold must leave nothing behind: no timer, immediate or process listener after it has been used and disposed.
import { test } from "node:test";
import { Redactor } from "@axis/audit";
import { createLogger, Disposables, exitCodeForStartupError, parseHostConfig, summarizeError } from "../src/index.js";
import { fakeClock, processSnapshot, settledTo, validConfig, wait } from "./helpers.js";

test("using every part of the scaffold leaves no timers and no process listeners", async () => {
  const before = processSnapshot();
  const d = new Disposables({ itemTimeoutMs: 20 });
  const logger = createLogger({ redactor: new Redactor(), clock: fakeClock(), sink: { write: () => undefined } });
  d.setInterval(() => logger.info("host.ready"), 2);
  d.setTimeout(() => logger.info("host.starting"), 1);
  d.add(() => new Promise<void>(() => undefined), "hangs");
  d.add(() => { throw new Error("x"); }, "throws");
  await wait(10);
  for (let i = 0; i < 100; i++) {
    parseHostConfig(validConfig(), new Redactor());
    try { parseHostConfig({}, new Redactor()); } catch (e) { exitCodeForStartupError(e); summarizeError(e); }
  }
  await d.dispose();
  await settledTo(before);
});

test("settledTo passes once a closing handle is gone and fails, bounded, while a timer is still live", async () => {
  const before = processSnapshot();
  const t = setTimeout(() => undefined, 60_000);
  await assert.rejects(settledTo(before, "a live timer", 200), { name: "AssertionError" });
  clearTimeout(t);
  await settledTo(before, "released", 2_000);
});
