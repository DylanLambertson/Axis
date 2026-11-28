// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// One instance per profile (main/instance.ts). Mutants each test kills: I1 a second instance that keeps running (and would fork a
// second daemon); I2 the first instance not showing its window on a second launch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { claimSingleInstance } from "../main/instance.js";

function fakeApp(locked: boolean) {
  const calls: string[] = [];
  let second: (() => void) | undefined;
  return {
    calls,
    fire: () => second?.(),
    app: {
      requestSingleInstanceLock: () => (calls.push("lock"), locked),
      on: (_e: "second-instance", l: () => void) => void (second = l),
      exit: (code: number) => void calls.push(`exit ${code}`),
    },
  };
}

test("a second instance exits at once and says why", () => {
  const f = fakeApp(false);
  const lines: string[] = [];
  assert.equal(claimSingleInstance(f.app, () => {}, (l) => lines.push(l)), false, "I1");
  assert.deepEqual(f.calls, ["lock", "exit 0"], "I1");
  assert.match(lines.join(""), /another instance/);
});

test("the first instance shows its window when a second launch asks", () => {
  const f = fakeApp(true);
  let shown = 0;
  assert.equal(claimSingleInstance(f.app, () => void shown++, () => {}), true);
  assert.deepEqual(f.calls, ["lock"]);
  f.fire();
  assert.equal(shown, 1, "I2");
});
