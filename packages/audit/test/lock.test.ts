// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { AxisError, InstanceLock, acquireInstanceLock, openDatabase, parseProcStatStart, processStartTime } from "../src/index.js";

const dirOf = () => mkdtempSync(join(tmpdir(), "axis-lock-"));
const conflict = (e: unknown) => e instanceof AxisError && e.code === "E_CONFLICT";

test("a second acquisition while the first is held is E_CONFLICT; release lets the next one in", () => {
  const dir = dirOf();
  try {
    const a = acquireInstanceLock(dir);
    assert.equal(a.held, true);
    assert.equal(statSync(a.path).mode & 0o777, process.platform === "win32" ? statSync(a.path).mode & 0o777 : 0o600);
    assert.throws(() => acquireInstanceLock(dir), conflict);
    a.release();
    assert.equal(a.held, false);
    assert.equal(existsSync(a.path), false);
    const b = acquireInstanceLock(dir);
    assert.equal(b.held, true);
    b.release();
    a.release(); // releasing twice is harmless and does not remove b's lock
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a lock whose process has died is stale and is taken over", async () => {
  const dir = dirOf();
  try {
    const child = spawn(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    await new Promise((r) => child.on("exit", r));
    const deadPid = Number(out);
    const dead = acquireInstanceLock(dir, { pid: deadPid });
    assert.equal(dead.held, true);
    const taken = acquireInstanceLock(dir); // real isAlive says the dead pid is gone
    assert.equal(taken.held, true);
    assert.equal(JSON.parse(readFileSync(taken.path, "utf8")).pid, process.pid);
    dead.release(); // not ours any more: must not delete the new holder's file
    assert.equal(existsSync(taken.path), true);
    taken.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a live pid whose OS start time differs from the recorded one is a reused pid, so the lock is stale", () => {
  const dir = dirOf();
  try {
    const first = acquireInstanceLock(dir, { pid: 4242, procStart: () => "Mon Nov  2 10:00:00 2026", isAlive: () => true });
    assert.equal(first.held, true);
    assert.throws(() => acquireInstanceLock(dir, { isAlive: () => true, procStart: (p) => (p === 4242 ? "Mon Nov  2 10:00:00 2026" : "x") }), conflict);
    const taken = acquireInstanceLock(dir, { isAlive: () => true, procStart: (p) => (p === 4242 ? "Tue Nov  3 09:00:00 2026" : "y") });
    assert.equal(taken.held, true);
    taken.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unparseable lock file is respected while fresh and replaced once old", () => {
  const dir = dirOf();
  try {
    const path = join(dir, "axis.lock");
    writeFileSync(path, "{half a rec");
    assert.throws(() => acquireInstanceLock(dir), conflict);
    const old = new Date(Date.now() - 60_000);
    utimesSync(path, old, old);
    const l = acquireInstanceLock(dir);
    assert.equal(l.held, true);
    l.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two processes racing for the lock: exactly one wins", async () => {
  const dir = dirOf();
  try {
    const racer = fileURLToPath(new URL("./fixtures/lock-racer.js", import.meta.url));
    const run = () =>
      new Promise<string>((resolve) => {
        const c = spawn(process.execPath, [racer, dir], { stdio: ["ignore", "pipe", "ignore"] });
        let out = "";
        c.stdout.on("data", (d: Buffer) => (out += d.toString()));
        c.on("exit", () => resolve(out));
      });
    const results = (await Promise.all([run(), run(), run()])).sort();
    assert.deepEqual(results, ["E_CONFLICT", "E_CONFLICT", "won"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("processStartTime reports a stable value for a live pid", () => {
  const a = processStartTime(process.pid);
  assert.ok(a === undefined || a.length > 0);
  assert.equal(processStartTime(process.pid), a);
});

test("an InstanceLock is a branded class: a lookalike is not one and the constructor is not open", () => {
  const dir = dirOf();
  try {
    const lock = acquireInstanceLock(dir);
    assert.equal(InstanceLock.is(lock), true);
    for (const fake of [{ path: lock.path, held: true, release() {} }, Object.create(InstanceLock.prototype), null, undefined, "x"]) {
      assert.equal(InstanceLock.is(fake), false);
    }
    assert.throws(() => new InstanceLock(Symbol("x"), lock.path, "n"), (e: unknown) => e instanceof AxisError && e.code === "E_INVALID_ARGUMENT");
    lock.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("guards(db) is true for the database's own directory only, and false once released", () => {
  const dir = dirOf();
  const other = dirOf();
  try {
    const db = openDatabase(join(dir, "a.db"));
    const lock = acquireInstanceLock(dir);
    const unrelated = acquireInstanceLock(other);
    assert.equal(lock.guards(db), true);
    assert.equal(unrelated.guards(db), false);
    assert.equal(unrelated.guards(openDatabase(":memory:")), true, "an in-memory database has no directory to guard");
    lock.release();
    assert.equal(lock.guards(db), false);
    unrelated.release();
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});

test("a takeover guard left by a crashed taker is cleared once old, and a live one defers the taker", () => {
  const dir = dirOf();
  try {
    const first = acquireInstanceLock(dir, { pid: 999_999_001, isAlive: () => true, procStart: () => "s1" });
    const guard = `${first.path}.takeover`;
    writeFileSync(guard, "");
    const deadHolder = { isAlive: (p: number) => p !== 999_999_001, procStart: () => "s1" };
    // The lock is stale (holder dead) but a fresh guard means another taker is mid-takeover: this attempt must not delete the file.
    assert.throws(() => acquireInstanceLock(dir, deadHolder), conflict);
    assert.equal(existsSync(first.path), true);
    // Once the guard is old it is cleared and the takeover proceeds.
    const old = (Date.now() - 60_000) / 1000;
    utimesSync(guard, old, old);
    for (let i = 0; i < 3; i++) {
      try {
        acquireInstanceLock(dir, deadHolder).release();
        break;
      } catch (e) {
        assert.ok(conflict(e));
      }
    }
    assert.equal(existsSync(guard), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseProcStatStart reads starttime from a Linux /proc stat line, whatever the command name contains", () => {
  const tail = "S 1 1234 1234 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 987654 12345678 123 18446744073709551615 1 1 0 0 0 0 0 0 0 0 0 0 17 3 0 0 0 0 0";
  for (const comm of ["node", "my proc", "a (b) c", "x) S 1 2", "((", ")"]) {
    assert.equal(parseProcStatStart(`4242 (${comm}) ${tail}`), "987654", comm);
  }
  for (const bad of ["", "garbage", "1 (x)", "1 (x) S 1 2 3", "1 (x) " + tail.replace("987654", "abc")]) {
    assert.equal(parseProcStatStart(bad), undefined, bad);
  }
});
