// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Regression tests for the re-review of the audit package (NEW-A to NEW-J, S4, S5, S10).
import assert from "node:assert/strict";
import { test } from "node:test";
import { AuditLog, AxisError, MAX_STRING_CHARS, Redactor, canonicalize, isWellFormedString, openDatabase } from "../src/index.js";

// Low-entropy, runtime-assembled stand-ins; none is a credential.
const PW = "Tr0ub4" + "dor-and-3";
const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e instanceof AxisError ? e.code : `raw:${(e as Error).constructor.name}`;
  }
};
const ev = (payload?: unknown, action = "tier4.execute") =>
  ({ actor: "user", action, target: "t", outcome: "success", payload }) as const;

// ---- NEW-B / S4: `name: value` shapes ----

test("NEW-B: colon-separated secret shapes in free text are redacted", () => {
  const r = new Redactor();
  const cases = [
    "pass" + "word: " + PW,
    "client_" + "secret: " + PW,
    "Pass" + "word : " + PW,
    '{"aws_' + "secret_access_" + 'key": "' + PW + '"}',
    '{"db_' + 'password":"' + PW + '","other":1}',
    JSON.stringify(JSON.stringify({ ["api_" + "token"]: PW })),
    "secret_" + "key: " + PW,
    "x-api-" + "key: " + PW,
    "Cookie: sid=" + PW,
    "Authori" + "zation: Bearer " + PW + PW,
    "to" + "ken='" + PW + "'",
    "export DB_" + "PWD=" + PW,
    "failed: pass" + "word: " + PW + " (retry)",
  ];
  for (const c of cases) {
    const out = r.redactString(c);
    assert.ok(!out.includes("Tr0ub4"), `leak: ${c} -> ${out}`);
    assert.equal(r.redactString(out), out, `not idempotent: ${out}`);
  }
});

test("NEW-B: ordinary prose and non-secret names are left alone", () => {
  const r = new Redactor();
  for (const s of ["status: ok", "monkey: banana", "commit message: fix the build", "see https://example.test/a:b"]) {
    assert.equal(r.redactString(s), s);
  }
});

test("NEW-B: an allowlisted free-text field cannot carry a secret into the log", () => {
  const log = new AuditLog(openDatabase(":memory:"));
  const reason = "git push failed: pass" + "word: " + PW;
  const e = log.append(ev({ reason, code: "client_" + "secret: " + PW, errorName: "pass" + "word=" + PW }));
  const stored = JSON.stringify(e.payload);
  assert.ok(!stored.includes("Tr0ub4"), stored);
  const raw = JSON.stringify(log.list()[0]);
  assert.ok(!raw.includes("Tr0ub4"), raw);
});

test("NEW-B: the policy redacts every kept string itself, even if the caller did not", async () => {
  const { applyPayloadPolicy } = await import("../src/payload-policy.js");
  const out = applyPayloadPolicy("tier4.execute", { reason: "pass" + "word: " + PW }, {}, (s) => s.replaceAll("Tr0ub4", "X")) as Record<string, unknown>;
  assert.deepEqual(Object.keys(out), ["[content]"], "an action with no allowlist keeps only a summary");
  const allowed = applyPayloadPolicy("a.b", { reason: "pass" + "word: " + PW }, { "a.b": ["reason"] }, (s) => s.replaceAll("Tr0ub4", "X")) as Record<string, string>;
  assert.ok(!allowed["reason"]?.includes("Tr0ub4"));
});

// ---- NEW-C / S5: sensitive keys count toward the node budget ----

test("NEW-C: a million sensitive keys is bounded, fast and cannot flood the log", () => {
  const r = new Redactor();
  const flood: Record<string, string> = {};
  for (let i = 0; i < 1_000_000; i++) flood[`k${i}tok` + "en"] = "x";
  const t0 = performance.now();
  const out = r.redactValue(flood) as Record<string, unknown>;
  const ms = performance.now() - t0;
  assert.ok(Object.keys(out).length <= 1025, `emitted ${Object.keys(out).length} entries`);
  assert.ok(String(out["[truncated]"]).startsWith("[TRUNCATED:size"));
  assert.ok(ms < 15_000, `redactValue took ${ms.toFixed(0)} ms (unbounded work took minutes of CPU at this size)`);

  const log = new AuditLog(openDatabase(":memory:"));
  const t1 = performance.now();
  const e = log.append(ev(flood));
  const appendMs = performance.now() - t1;
  assert.ok(appendMs < 15_000, `append took ${appendMs.toFixed(0)} ms`);
  assert.ok(JSON.stringify(e.payload).length < 1024);
});

test("NEW-C: many sensitive keys with long names, and plain keys beyond the per-object cap, are cut", () => {
  const r = new Redactor();
  const o: Record<string, string> = {};
  for (let i = 0; i < 2000; i++) o["x".repeat(16_000) + i + "pass" + "word"] = "v";
  const t0 = performance.now();
  const out = r.redactValue(o) as Record<string, unknown>;
  assert.ok(performance.now() - t0 < 10_000);
  assert.ok(Object.keys(out).every((k) => k.length <= 300));
  assert.ok(Object.keys(out).length <= 1025);

  const plain: Record<string, number> = {};
  for (let i = 0; i < 5000; i++) plain[`f${i}`] = i;
  assert.equal(Object.keys(r.redactValue(plain) as object).length, 1025);
});

test("NEW-C: a few sensitive keys are still redacted whole", () => {
  const r = new Redactor();
  assert.deepEqual(r.redactValue({ ["pass" + "word"]: PW, ok: 1 }), { ["pass" + "word"]: "[REDACTED:sensitive-field]", ok: 1 });
});

// ---- NEW-A: durability settings ----

test("NEW-A: on macOS the database is opened with fullfsync and checkpoint_fullfsync; synchronous is FULL everywhere", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "axis-fsync-"));
  try {
    const db = openDatabase(join(dir, "f.db"));
    const get = (name: string): unknown => (db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown>)[name];
    assert.equal(get("synchronous"), 2);
    assert.equal(get("journal_mode"), "wal");
    if (process.platform === "darwin") {
      assert.equal(get("fullfsync"), 1);
      assert.equal(get("checkpoint_fullfsync"), 1);
    }
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- NEW-F: the encoded-run pass is alignment-independent ----

test("NEW-F: base64 of user:secret is caught whatever precedes it", () => {
  const r = new Redactor();
  r.registerSecret("hunter2" + "hunter2" + "xyz");
  const b64 = Buffer.from("user:" + "hunter2hunter2xyz").toString("base64");
  const url64 = Buffer.from("user:" + "hunter2hunter2xyz").toString("base64url");
  for (const prefix of ["", "/a/", "x_", "/v2/x/", "ab-", "a"]) {
    for (const enc of [b64, url64]) {
      const out = r.redactString(`GET https://h${prefix}${enc}`);
      assert.ok(!out.includes(enc) && !out.includes(enc.slice(4)), `prefix ${JSON.stringify(prefix)}: ${out}`);
    }
  }
  assert.equal(r.redactString("see https://example.test/some/long/path/segment/abc"), "see https://example.test/some/long/path/segment/abc");
});

// ---- NEW-G: incremental verification does not trust the anchor row's stored hash ----

test("NEW-G: an edit to the anchor row itself is caught by the incremental check", () => {
  const db = openDatabase(":memory:");
  const log = new AuditLog(db);
  for (let i = 0; i < 5; i++) log.append({ actor: "user", action: "worktree.create", target: `w:${i}`, outcome: "success" });
  const anchor = log.checkpoint();
  assert.ok(anchor);
  log.append({ actor: "user", action: "worktree.create", target: "w:after", outcome: "success" });
  db.exec("DROP TRIGGER audit_events_no_update");
  db.prepare("UPDATE audit_events SET target = 'forged' WHERE seq = ?").run(anchor.seq); // content edited, hash column untouched
  assert.equal(code(() => log.checkpoint(anchor)), "E_INTERNAL");
  const r = log.verify({ from: anchor });
  assert.ok(!r.ok && r.firstBadSeq === anchor.seq && r.reason === "hash_mismatch");
});

// ---- NEW-J: canonical JSON and directories ----

test("NEW-J: canonicalize rejects array holes instead of emitting invalid JSON", async () => {
  // eslint-disable-next-line no-sparse-arrays
  assert.throws(() => canonicalize([, 1]), (e: unknown) => e instanceof AxisError && e.code === "E_INVALID_ARGUMENT");
  assert.equal(canonicalize([1, 2]), "[1,2]");
  assert.equal(canonicalize(new Array(0)), "[]");
});

test("NEW-J: opening a database in an existing shared directory does not change that directory's mode", { skip: process.platform === "win32" }, async () => {
  const { chmodSync, mkdtempSync, rmSync, statSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "axis-share-"));
  try {
    chmodSync(dir, 0o755);
    openDatabase(join(dir, "x.db")).close();
    assert.equal(statSync(dir).mode & 0o777, 0o755);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- schema pin: a shipped migration is never edited ----

test("the shipped audit migration is pinned by hash (add a new migration instead of editing it)", async () => {
  const { createHash } = await import("node:crypto");
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const src = readFileSync(fileURLToPath(new URL("../../src/log.ts", import.meta.url)), "utf8");
  const sql = /sql: `([\s\S]*?)`,\n  \},\n\];/.exec(src)?.[1];
  assert.ok(sql, "migration 1 not found");
  assert.equal(createHash("sha256").update(sql).digest("hex"), PINNED_AUDIT_MIGRATION_1);
});
const PINNED_AUDIT_MIGRATION_1 = "2f4a68e5e4e21432d4a86a4c9708b5b9e40235aec8e222e8620a019386baf811";

// ---- existing data directory safety ----

const posixOnly = { skip: process.platform === "win32" };

async function tmp() {
  const { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const base = realpathSync(mkdtempSync(join(tmpdir(), "axis-dirsafe-")));
  return { base, join, chmodSync, existsSync, mkdirSync, statSync, symlinkSync, done: () => rmSync(base, { recursive: true, force: true }) };
}
const reasonOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e instanceof AxisError && e.code === "E_INVALID_ARGUMENT" ? String(e.detail["reason"]) : `other:${String(e)}`;
  }
};

test("data directory: world-writable and group-writable directories are refused, untouched, and no database is created", posixOnly, async () => {
  const t = await tmp();
  try {
    for (const [mode, reason] of [[0o777, "group-writable"], [0o757, "world-writable"], [0o770, "group-writable"], [0o1777, "group-writable"]] as const) {
      const dir = t.join(t.base, `d${mode.toString(8)}`);
      t.mkdirSync(dir);
      t.chmodSync(dir, mode);
      assert.equal(reasonOf(() => openDatabase(t.join(dir, "a.db"))), reason, mode.toString(8));
      assert.equal(t.statSync(dir).mode & 0o7777, mode, "the mode must not be changed");
      assert.equal(t.existsSync(t.join(dir, "a.db")), false, "nothing is created in an unsafe directory");
    }
    const msg = (() => {
      try {
        openDatabase(t.join(t.base, "d777", "a.db"));
      } catch (e) {
        return (e as Error).message;
      }
      return "";
    })();
    assert.ok(!msg.includes(t.base), "the error must not carry the path");
  } finally {
    t.done();
  }
});

test("data directory: a symlinked directory is refused, even when its target is safe", posixOnly, async () => {
  const t = await tmp();
  try {
    const real = t.join(t.base, "real");
    t.mkdirSync(real, { mode: 0o700 });
    t.symlinkSync(real, t.join(t.base, "link"));
    assert.equal(reasonOf(() => openDatabase(t.join(t.base, "link", "a.db"))), "symlink");
    // A symlinked ANCESTOR (as /tmp and /var are on macOS) is fine: the real directory is what is judged.
    const viaAncestor = t.join(t.base, "linkroot");
    t.symlinkSync(t.base, viaAncestor);
    openDatabase(t.join(viaAncestor, "real", "a.db")).close();
  } finally {
    t.done();
  }
});

test("data directory: a directory owned by another user is refused (simulated through the injected stat)", posixOnly, async () => {
  const t = await tmp();
  try {
    const dir = t.join(t.base, "mine");
    t.mkdirSync(dir, { mode: 0o700 });
    const real = {
      lstat: (p: string) => ({ ...t.statSync(p), isSymbolicLink: () => false }),
      stat: (p: string) => t.statSync(p),
      realpath: (p: string) => p,
    };
    const ours = process.getuid?.() ?? 0;
    assert.equal(reasonOf(() => openDatabase(t.join(dir, "a.db"), { directoryFs: { ...real, uid: () => ours + 1 } })), "not-owned");
    openDatabase(t.join(dir, "a.db"), { directoryFs: { ...real, uid: () => ours } }).close();
  } finally {
    t.done();
  }
});

test("data directory: the normal cases pass: an existing 0700 or 0755 directory, and a new one is created 0700", posixOnly, async () => {
  const t = await tmp();
  try {
    for (const mode of [0o700, 0o755, 0o750]) {
      const dir = t.join(t.base, `ok${mode.toString(8)}`);
      t.mkdirSync(dir);
      t.chmodSync(dir, mode);
      openDatabase(t.join(dir, "a.db")).close();
      assert.equal(t.statSync(dir).mode & 0o777, mode, "an existing directory is not chmod-ed");
    }
    const fresh = t.join(t.base, "a", "b");
    openDatabase(t.join(fresh, "a.db")).close();
    assert.equal(t.statSync(fresh).mode & 0o777, 0o700);
    openDatabase(":memory:").close();
  } finally {
    t.done();
  }
});

test("data directory: the instance lock applies the same check to an existing directory", posixOnly, async () => {
  const t = await tmp();
  try {
    const { acquireInstanceLock } = await import("../src/index.js");
    const dir = t.join(t.base, "shared");
    t.mkdirSync(dir);
    t.chmodSync(dir, 0o777);
    assert.equal(reasonOf(() => acquireInstanceLock(dir)), "group-writable");
    t.chmodSync(dir, 0o700);
    acquireInstanceLock(dir).release();
  } finally {
    t.done();
  }
});

// ---- the in-memory carve-out is unreachable from a file-backed database ----

test("guards(): no file-backed database, whatever its name, takes the in-memory carve-out", posixOnly, async () => {
  const t = await tmp();
  try {
    const { acquireInstanceLock } = await import("../src/index.js");
    const other = t.join(t.base, "other");
    t.mkdirSync(other, { mode: 0o700 });
    const elsewhere = acquireInstanceLock(other);
    const mine = t.join(t.base, "mine");
    for (const name of [":memory:", "x.db", "file::memory:", "memory", ":memory:-wal"]) {
      const db = openDatabase(t.join(mine, name));
      assert.equal(elsewhere.guards(db), false, name);
      db.close();
    }
    // A relative "./:memory:" is a file too.
    const cwd = process.cwd();
    process.chdir(mine);
    try {
      const db = openDatabase("./:memory:");
      assert.equal(elsewhere.guards(db), false);
      db.close();
    } finally {
      process.chdir(cwd);
    }
    // A closed database is not guarded; a true in-memory one is, by any held lock.
    const closed = openDatabase(t.join(mine, "c.db"));
    closed.close();
    assert.equal(elsewhere.guards(closed), false);
    assert.equal(elsewhere.guards(openDatabase(":memory:")), true);
    elsewhere.release();
  } finally {
    t.done();
  }
});

// ---- the truncation markers are deterministic ----

test("truncation is deterministic: the same oversized payload gives the same stored form and the same event hash", () => {
  const big = (): Record<string, unknown> => {
    const o: Record<string, unknown> = { workspaceId: "w1", reason: "x".repeat(40_000) };
    for (let i = 0; i < 5000; i++) o[`field${i}`] = { nested: i, text: "y".repeat(30) };
    return o;
  };
  const T = new Date("2026-11-02T00:00:00.000Z");
  const hashes: string[] = [];
  for (let run = 0; run < 2; run++) {
    const db = openDatabase(":memory:");
    const log = new AuditLog(db, { now: () => T });
    const e1 = log.append(ev(big()));
    const e2 = log.append(ev(big(), "made.up"));
    assert.equal(log.verify().ok, true, "stored truncated forms must verify");
    assert.equal(canonicalize(log.list()[0]?.payload), canonicalize(e1.payload));
    hashes.push(e1.hash + e2.hash);
  }
  assert.equal(hashes[0], hashes[1]);
  const r = new Redactor();
  assert.equal(JSON.stringify(r.redactValue(big())), JSON.stringify(r.redactValue(big())));
  assert.equal(r.redactString("a".repeat(40_000)), r.redactString("a".repeat(40_000)));
});

// ---- D2-B1: truncation must be linear (the trailing-token strip was O(run squared)) ----

test("D2-B1: one string with a long token run before the cut redacts in milliseconds", () => {
  const r = new Redactor();
  for (const input of [
    "b".repeat(MAX_STRING_CHARS - 1) + ":" + "x",
    "b".repeat(MAX_STRING_CHARS - 1) + "\n" + "x".repeat(100_000),
    "ab+/=.-_".repeat(4000) + " " + "y".repeat(50_000),
    "=".repeat(1_000_000) + "x",
  ]) {
    const t0 = performance.now();
    const out = r.redactString(input);
    const ms = performance.now() - t0;
    assert.ok(ms < 250, `took ${ms.toFixed(0)} ms`);
    assert.ok(out.length <= MAX_STRING_CHARS + 32);
  }
});

test("D2-B1: 64 such strings in one payload append in under a second (it took 20 s)", () => {
  const log = new AuditLog(openDatabase(":memory:"));
  const payload: Record<string, string> = {};
  for (let i = 0; i < 64; i++) payload[`field${i}`] = "b".repeat(MAX_STRING_CHARS - 1) + ":" + "x";
  const t0 = performance.now();
  log.append(ev(payload));
  const ms = performance.now() - t0;
  assert.ok(ms < 1000, `append took ${ms.toFixed(0)} ms`);
  const t1 = performance.now();
  new Redactor().redactValue(Array.from({ length: 64 }, () => "b".repeat(MAX_STRING_CHARS - 1) + ":" + "x"));
  assert.ok(performance.now() - t1 < 1000);
});

test("D2-B1: the cut still drops a partial token and records the original length", () => {
  const r = new Redactor();
  const out = r.redactString("word ".repeat(4000) + "ghp_" + "a1B2c3".repeat(7) + " tail".repeat(10_000));
  assert.match(out, /\[TRUNCATED:\d+\]$/);
  assert.ok(!out.includes("ghp_a1B2c3"));
  const exact = r.redactString("a ".repeat(MAX_STRING_CHARS / 2 - 1) + "tokentoken" + "z".repeat(MAX_STRING_CHARS));
  assert.ok(!exact.includes("tokentoken") || exact.includes("TRUNCATED"));
});

test("D2-B1: the cut comes before any other work, so a huge string of lone surrogates costs the same as a small one", () => {
  const r = new Redactor();
  const huge = "\udc00".repeat(8_000_000);
  const t0 = performance.now();
  const out = r.redactString(huge);
  assert.ok(performance.now() - t0 < 250, "surrogate repair ran on the whole input");
  assert.ok(out.length <= MAX_STRING_CHARS + 32);
  assert.ok(isWellFormedString(out));
  assert.match(out, /\[TRUNCATED:8000000\]$/);
  // A pair split by the cut is dropped, never left as a lone half.
  const split = "a".repeat(MAX_STRING_CHARS - 1) + "😀" + "b".repeat(100);
  assert.ok(isWellFormedString(r.redactString(split)));
});

// ---- D2-6: `..` after a symlink is judged the way the kernel resolves it ----

test("data directory: `safe/link/../x.db` is judged by where `..` really leads, not by its lexical parent", posixOnly, async () => {
  const t = await tmp();
  try {
    const safe = t.join(t.base, "safe");
    const shared = t.join(t.base, "shared");
    t.mkdirSync(safe, { mode: 0o700 });
    t.mkdirSync(t.join(shared, "sub"), { recursive: true });
    t.chmodSync(shared, 0o777);
    t.symlinkSync(t.join(shared, "sub"), t.join(safe, "link"));
    // (Built by hand: path.join would collapse the `..` before openDatabase ever saw it.)
    // Lexically the parent is `safe` (0700, ours); physically it is `shared` (0777).
    assert.equal(reasonOf(() => openDatabase(`${safe}/link/../x.db`)), "group-writable");
    assert.equal(t.existsSync(t.join(shared, "x.db")), false, "no database may be created in the shared directory");
    assert.equal(t.existsSync(t.join(safe, "x.db")), false);

    // The same shape with a SAFE physical parent is fine, and the database lands where `..` leads.
    const ok = t.join(t.base, "ok");
    t.mkdirSync(t.join(ok, "sub"), { recursive: true });
    t.chmodSync(ok, 0o700);
    t.symlinkSync(t.join(ok, "sub"), t.join(safe, "oklink"));
    openDatabase(`${safe}/oklink/../y.db`).close();
    assert.equal(t.existsSync(t.join(ok, "y.db")), true);
    assert.equal(t.existsSync(t.join(safe, "y.db")), false);

    // A missing directory is never created through a `..` path (it could not be judged first).
    assert.equal(reasonOf(() => openDatabase(`${t.base}/missing/../z.db`)), "dotdot-path");
    assert.equal(t.existsSync(t.join(t.base, "missing")), false);
    // Relative paths work as before.
    const cwd = process.cwd();
    process.chdir(ok);
    try {
      openDatabase("rel.db").close();
      assert.equal(t.existsSync(t.join(ok, "rel.db")), true);
    } finally {
      process.chdir(cwd);
    }
  } finally {
    t.done();
  }
});

test("data directory: the lock and guards() also follow `..` after a symlink physically", posixOnly, async () => {
  const t = await tmp();
  try {
    const { acquireInstanceLock } = await import("../src/index.js");
    const safe = t.join(t.base, "safe");
    const real = t.join(t.base, "real");
    t.mkdirSync(safe, { mode: 0o700 });
    t.mkdirSync(t.join(real, "sub"), { recursive: true });
    t.chmodSync(real, 0o700);
    t.symlinkSync(t.join(real, "sub"), t.join(safe, "link"));
    const raw = `${safe}/link/..`; // physically: real
    const lock = acquireInstanceLock(raw);
    assert.equal(t.existsSync(t.join(real, "axis.lock")), true, "the lock file lives where `..` leads");
    assert.equal(t.existsSync(t.join(safe, "axis.lock")), false);
    const db = openDatabase(`${raw}/j.db`);
    assert.equal(lock.guards(db), true);
    db.close();
    lock.release();
    // A database in `safe` is not guarded by that lock.
    const lock2 = acquireInstanceLock(raw);
    const other = openDatabase(t.join(safe, "k.db"));
    assert.equal(lock2.guards(other), false);
    other.close();
    lock2.release();
  } finally {
    t.done();
  }
});
