// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createPtyProcessPort, createPtyService, isAbsolutePath, PtySpawnError } from "../src/index.js";
import { channelPair, FakeChild, FakeProcs } from "../testing/helpers.js";
import { SPEC } from "../testing/rig.js";

test("S4: isAbsolutePath is platform aware and never touches the file system", () => {
  for (const p of ["/bin/sh", "/", "/a b/c"]) assert.equal(isAbsolutePath(p, "linux"), true, p);
  for (const p of ["", "sh", "./sh", "../sh", "a/b", "~/x", "C:\\x", "\\x", " /bin/sh"]) assert.equal(isAbsolutePath(p, "linux"), false, p);
  assert.equal(isAbsolutePath("/bin/sh", "darwin"), true);
  for (const p of ["C:\\x\\y.exe", "c:/x", "D:\\", "\\\\server\\share\\x", "\\\\?\\C:\\x"]) assert.equal(isAbsolutePath(p, "win32"), true, p);
  for (const p of ["", "x.exe", "C:x", "\\x", "/x", "\\\\", "\\\\server", "..\\x"]) assert.equal(isAbsolutePath(p, "win32"), false, p);
  assert.equal(isAbsolutePath("/bin/s\0h", "linux"), false, "NUL is never part of a path");
});

async function spawnWith(spec: { argv?: readonly string[]; cwd?: string }, platform: NodeJS.Platform = "linux"): Promise<{ error: unknown; calls: number }> {
  const pair = channelPair();
  let calls = 0;
  const svc = createPtyService({ spawn: () => (calls++, new FakeChild(500)), ops: new FakeProcs(), platform });
  svc.serveControl(pair.b);
  const port = createPtyProcessPort({ channel: pair.a, ops: new FakeProcs() });
  let error: unknown;
  try {
    await port.spawn({ ...SPEC, argv: spec.argv ?? SPEC.argv, cwd: spec.cwd ?? SPEC.cwd });
  } catch (e) {
    error = e;
  }
  svc.dispose();
  port.dispose();
  return { error, calls };
}

const refused = (e: unknown): boolean => e instanceof PtySpawnError && e.code === "spawn_failed";

test("S4: a relative argv[0] is refused and the spawn function is never called", async () => {
  for (const argv of [["sh"], ["./sh"], ["bin/sh", "-c", "x"]]) {
    const r = await spawnWith({ argv });
    assert.ok(refused(r.error), JSON.stringify(argv));
    assert.equal(r.calls, 0, JSON.stringify(argv));
  }
});

test("S4: a relative cwd is refused", async () => {
  for (const cwd of [".", "work", "../x"]) {
    const r = await spawnWith({ cwd });
    assert.ok(refused(r.error), cwd);
    assert.equal(r.calls, 0);
  }
});

test("S4: NUL in any argv entry or in cwd is refused", async () => {
  for (const spec of [{ argv: ["/bin/sh", "-c", "a\0b"] }, { argv: ["/bin/s\0h"] }, { cwd: "/w\0x" }]) {
    const r = await spawnWith(spec);
    assert.ok(refused(r.error), JSON.stringify(spec));
    assert.equal(r.calls, 0);
  }
});

test("S4: absolute paths pass, with the platform's own idea of absolute", async () => {
  assert.equal((await spawnWith({})).error, undefined);
  assert.ok(refused((await spawnWith({ argv: ["C:\\x\\a.exe"], cwd: "C:\\w" })).error), "a Windows path is not absolute on linux");
  const win = await spawnWith({ argv: ["C:\\x\\a.exe"], cwd: "C:\\w" }, "win32");
  assert.equal(win.error, undefined);
  assert.ok(refused((await spawnWith({}, "win32")).error), "a POSIX path is not absolute on win32");
});
