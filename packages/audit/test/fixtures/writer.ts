// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { AuditLog, openDatabase } from "../../src/index.js";

const [dbPath, id, count] = process.argv.slice(2);
if (!dbPath || !id || !count) process.exit(2);
const log = new AuditLog(openDatabase(dbPath));
for (let i = 0; i < Number(count); i++) {
  log.append({ actor: "daemon", action: "daemon.write", target: `writer:${id}`, outcome: "success", payload: { i } });
}
