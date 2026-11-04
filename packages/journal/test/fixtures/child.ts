// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Crash fixture. Run steps 1..k committed, then (mode "open-tx") perform step k+1
// or recovery inside an open transaction, announce READY and hang until killed.
import { dirname } from "node:path";
import { acquireInstanceLock, openDatabase } from "@axis/audit";
import { userPrincipal } from "../../src/daemon-principal.js";
import { STEPS, deterministicJournal, type Ctx } from "./script.js";

const USER = userPrincipal();

const [dbPath, mode, kArg] = process.argv.slice(2);
if (!dbPath || !mode) process.exit(2);
const k = Number(kArg ?? "0");

const db = openDatabase(dbPath);
const { journal } = deterministicJournal(db);
const ctx: Ctx = { ws: "", r1: "", r2: "", ws2: "" };

// Ids are positional, so rebuild ctx from the committed rows when resuming is not needed:
// every child starts from an empty database and replays from step 1.
for (let i = 0; i < k; i++) STEPS[i]?.(journal, ctx);

/**
 * A workspace with an endless write loop; the parent kills it at a chosen instant. With `big` the loop runs inside one
 * open transaction under `cache_size = 1`, so dirty pages spill into the WAL file before any commit.
 */
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
    journal.transitionRun(r, "COMPLETED", { exitCode: 0, actor: USER });
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
