// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Crash fixture for the idempotency store. Announces READY at the chosen point, then hangs until killed.
import { AuditLog, Redactor, openDatabase } from "@axis/audit";
import { JournalIdempotencyStore, type StoreKey } from "../../src/index.js";

const [dbPath, mode] = process.argv.slice(2);
if (!dbPath || !mode) process.exit(2);

const db = openDatabase(dbPath);
const store = JournalIdempotencyStore.open(db, { audit: new AuditLog(db), redactor: new Redactor() });
const key = (n: string): StoreKey => ({ actorId: "a", workspaceId: "w", contract: "axis.test", version: 1, method: "m", key: n });
const ready = (): void => {
  process.stdout.write("READY\n");
  setInterval(() => undefined, 1000);
};

if (mode === "begun") {
  // killed between begin and complete: the handler may have run
  store.begin(key("k1"), "h1");
  ready();
} else if (mode === "completed") {
  store.begin(key("k1"), "h1");
  store.complete(key("k1"), { ok: true }, "c1");
  ready();
} else if (mode === "at-commit") {
  // killed at the COMMIT statement of complete: the write is staged in the WAL transaction, nothing is committed
  store.begin(key("k1"), "h1");
  const exec = db.exec.bind(db);
  db.exec = (sql: string): void => {
    if (sql === "COMMIT") {
      process.stdout.write("READY\n");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); // block until killed
    }
    exec(sql);
  };
  store.complete(key("k1"), { ok: true }, "c1");
} else if (mode === "fuzz") {
  process.stdout.write("READY\n");
  for (let i = 0; ; i++) {
    store.begin(key(`k${i}`), `h${i}`);
    if (i % 3 !== 0) store.complete(key(`k${i}`), { i }, "c");
  }
} else if (mode === "commit-race") {
  // many large commits back to back (synchronous=FULL), so a kill at a random instant often lands inside one
  process.stdout.write("READY\n");
  for (let i = 0; ; i++) {
    store.begin(key(`k${i}`), `h${i}`);
    store.complete(key(`k${i}`), { i, pad: "x".repeat(8_000) }, "c");
  }
}
