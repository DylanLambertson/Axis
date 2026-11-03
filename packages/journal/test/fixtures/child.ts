// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Crash fixture. Run steps 1..k committed, then (mode "open-tx") perform step k+1
// or recovery inside an open transaction, announce READY and hang until killed.
import { dirname } from "node:path";
import { acquireInstanceLock, openDatabase } from "@axis/audit";
import { STEPS, deterministicJournal, type Ctx } from "./script.js";

const [dbPath, mode, kArg] = process.argv.slice(2);
if (!dbPath || !mode) process.exit(2);
const k = Number(kArg ?? "0");

const db = openDatabase(dbPath);
const { journal } = deterministicJournal(db);
const ctx: Ctx = { ws: "", r1: "", r2: "", ws2: "" };

// Ids are positional, so rebuild ctx from the committed rows when resuming is not needed:
// every child starts from an empty database and replays from step 1.
for (let i = 0; i < k; i++) STEPS[i]?.(journal, ctx);

/** A workspace with a long-lived write loop: the parent kills it at a random instant, often inside COMMIT. */
function writeLoop(big: boolean): void {
  const ws = journal.createWorkspace({ projectId: "p", branch: "axis/fuzz", baseRef: "main", baseSha: "a".repeat(40), createdBy: "user" }).value.id;
  journal.transitionWorkspace(ws, "READY");
  if (big) {
    db.exec("PRAGMA cache_size = 1");
    db.exec("BEGIN IMMEDIATE");
  }
  process.stdout.write("READY\n");
  for (;;) {
    const r = journal.createRun({ workspaceId: ws, kind: "cli", createdBy: "user" }).value.id;
    journal.transitionRun(r, "RUNNING");
    journal.transitionRun(r, "REVIEWING");
    journal.transitionRun(r, "COMPLETED", { exitCode: 0, actor: "user" });
    if (big && Number(journal.listRuns().length) > 5000) setInterval(() => undefined, 1000);
  }
}

if (mode === "fuzz") writeLoop(false);
if (mode === "spill") writeLoop(true);

if (mode === "open-tx") {
  db.exec("BEGIN IMMEDIATE");
  const next = STEPS[k];
  if (next) next(journal, ctx);
} else if (mode === "recover-open-tx") {
  db.exec("BEGIN IMMEDIATE");
  journal.recover(acquireInstanceLock(dirname(dbPath)));
}
process.stdout.write("READY\n");
setInterval(() => undefined, 1000);
