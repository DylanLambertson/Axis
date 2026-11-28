// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The utility-process fork options. Mutants each test kills:
//   K1 `--disable-sigusr1` dropped, or any other execArgv added (pinned exactly); K2 stdio not piped; K3 an unknown service name
//   accepted; K4 a bad environment entry accepted, or the caller's object passed through unfrozen.
import { test } from "node:test";
import assert from "node:assert/strict";
import { UTILITY_EXEC_ARGV, utilityForkOptions } from "../src/index.js";

test("fork options: exactly --disable-sigusr1, piped stdio, a frozen copy of the given environment", () => {
  assert.deepEqual(UTILITY_EXEC_ARGV, ["--disable-sigusr1"], "K1");
  for (const name of ["axis-daemon", "axis-pty"] as const) {
    const env = { PATH: "/usr/bin", GONE: undefined };
    const o = utilityForkOptions(name, env);
    assert.deepEqual(o.execArgv, ["--disable-sigusr1"], "K1");
    assert.equal(o.stdio, "pipe", "K2");
    assert.equal(o.serviceName, name);
    assert.deepEqual({ ...o.env }, { PATH: "/usr/bin" });
    assert.equal(Object.isFrozen(o.env) && Object.isFrozen(o.execArgv) && Object.isFrozen(o), true, "K4");
    assert.notEqual(o.env, env as unknown, "K4");
  }
});

test("fork options: refusals", () => {
  assert.throws(() => utilityForkOptions("other" as "axis-daemon", {}), "K3");
  for (const env of [{ "A=B": "x" }, { "": "x" }, { A: "x\0y" }, { A: 1 as unknown as string }]) {
    assert.throws(() => utilityForkOptions("axis-daemon", env), `K4: ${JSON.stringify(env)}`);
  }
});
