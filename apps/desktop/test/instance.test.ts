// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// One instance per profile (main/instance.ts). Mutants each test kills: I1 a second instance that keeps running (and would fork a
// second daemon); I2 the first instance not showing its window on a second launch; I3 the lock taken before main set its profile
// path (it would lock Electron's default profile); I4 the handler reading the second launch's argv or working directory.
import { test } from "node:test";
import assert from "node:assert/strict";
import { claimSingleInstance } from "../main/instance.js";

function fakeApp(locked: boolean, userData = "/p/axis-shell") {
  const calls: string[] = [];
  let second: ((...a: unknown[]) => void) | undefined;
  return {
    calls,
    fire: (...a: unknown[]) => second?.(...a),
    app: {
      getPath: (_n: "userData") => userData,
      requestSingleInstanceLock: () => (calls.push("lock"), locked),
      on: (_e: "second-instance", l: (...a: unknown[]) => void) => void (second = l),
      exit: (code: number) => void calls.push(`exit ${code}`),
    },
  };
}

test("a second instance exits at once and says why", () => {
  const f = fakeApp(false);
  const lines: string[] = [];
  assert.equal(claimSingleInstance(f.app, "/p/axis-shell", () => {}, (l) => lines.push(l)), false, "I1");
  assert.deepEqual(f.calls, ["lock", "exit 0"], "I1");
  assert.match(lines.join(""), /another instance/);
});

test("the first instance shows its window when a second launch asks", () => {
  const f = fakeApp(true);
  let shown = 0;
  const args: unknown[][] = [];
  assert.equal(claimSingleInstance(f.app, "/p/axis-shell", (...a: unknown[]) => void (shown++, args.push(a)), () => {}), true);
  assert.deepEqual(f.calls, ["lock"]);
  f.fire({}, ["/opt/axis", "--evil", "axis://x"], "/tmp/attacker", { data: 1 });
  assert.equal(shown, 1, "I2");
  assert.deepEqual(args, [[]], "I4: nothing of the second launch reaches the window");
});

test("the lock is taken only on main's own profile", () => {
  const f = fakeApp(true, "/home/u/.config/@axis/desktop");
  assert.throws(() => claimSingleInstance(f.app, "/home/u/.config/axis-shell", () => {}, () => {}), /profile path/, "I3");
  assert.deepEqual(f.calls, [], "I3: no lock in the default profile");
});
