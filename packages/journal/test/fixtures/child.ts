// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Crash fixture. Run steps 1..k committed, then (mode "open-tx") perform step k+1
// or recovery inside an open transaction, announce READY and hang until killed.
import { openDatabase } from "@axis/audit";
import { STEPS, deterministicJournal, type Ctx } from "./script.js";

const [dbPath, mode, kArg] = process.argv.slice(2);
if (!dbPath || !mode) process.exit(2);
const k = Number(kArg ?? "0");

const db = openDatabase(dbPath);
const { journal } = deterministicJournal(db);
const ctx: Ctx = { ws: "", r1: "", r2: "" };

// Ids are positional, so rebuild ctx from the committed rows when resuming is not needed:
// every child starts from an empty database and replays from step 1.
for (let i = 0; i < k; i++) STEPS[i]?.(journal, ctx);

if (mode === "open-tx") {
  db.exec("BEGIN IMMEDIATE");
  const next = STEPS[k];
  if (next) next(journal, ctx);
} else if (mode === "recover-open-tx") {
  db.exec("BEGIN IMMEDIATE");
  journal.recover();
}
process.stdout.write("READY\n");
setInterval(() => undefined, 1000);
