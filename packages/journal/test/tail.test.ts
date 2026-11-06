// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AuditLog, openDatabase } from "@axis/audit";
import { Journal, MAX_TAIL_ROWS, lastTransitionId, transitionsSince } from "../src/index.js";

test("tail: committed transitions after a cursor, oldest first, ids and states only, bounded", () => {
  const db = openDatabase(":memory:");
  const journal = Journal.open(db, { audit: new AuditLog(db) });
  assert.equal(lastTransitionId(db), 0);
  assert.deepEqual(transitionsSince(db, 0, 10), []);
  const ws = journal.createWorkspace({ projectId: "p", branch: "axis/x", baseRef: "main", baseSha: "b".repeat(40), createdBy: "user" }).value;
  journal.transitionWorkspace(ws.id, "READY", { actor: "user", reason: "SOME_REASON" });
  const all = transitionsSince(db, 0, 10);
  assert.deepEqual(all.map((r) => [r.entity, r.entityId, r.to]), [["workspace", ws.id, "CREATING"], ["workspace", ws.id, "READY"]]);
  assert.deepEqual(Object.keys(all[0] ?? {}).sort(), ["entity", "entityId", "id", "to"], "no reason, actor or time");
  assert.equal(lastTransitionId(db), all[1]?.id);
  assert.deepEqual(transitionsSince(db, all[0]?.id ?? 0, 10).map((r) => r.to), ["READY"]);
  assert.equal(transitionsSince(db, 0, 1).length, 1);
  assert.equal(transitionsSince(db, 0, 0).length, 1, "a limit below 1 reads one row");
  assert.equal(transitionsSince(db, -5, Number.NaN).length, 1, "nonsense is clamped, never unbounded");
  assert.ok(MAX_TAIL_ROWS >= 512);
});
