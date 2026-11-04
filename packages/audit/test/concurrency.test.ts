// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { AuditLog, openDatabase } from "../src/index.js";

const WRITER = fileURLToPath(new URL("./fixtures/writer.js", import.meta.url));

function runWriter(dbPath: string, id: string, count: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WRITER, dbPath, id, String(count)], { stdio: ["ignore", "ignore", "inherit"] });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? -1));
  });
}

test("several processes appending concurrently produce one valid contiguous chain", async () => {
  const dir = mkdtempSync(join(tmpdir(), "axis-audit-mp-"));
  try {
    const path = join(dir, "journal.db");
    new AuditLog(openDatabase(path)).append({ actor: "daemon", action: "daemon.start", target: "daemon", outcome: "success" });
    const codes = await Promise.all(["a", "b", "c", "d"].map((id) => runWriter(path, id, 25)));
    assert.deepEqual(codes, [0, 0, 0, 0]);
    const log = new AuditLog(openDatabase(path));
    const result = log.verify();
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.count, 101);
    const perActor = new Map<string, number>();
    for (const e of log.list({ limit: 200 })) perActor.set(e.target, (perActor.get(e.target) ?? 0) + 1);
    assert.equal(perActor.get("writer:a"), 25);
    assert.equal(perActor.get("writer:d"), 25);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
