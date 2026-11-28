// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// DC-3a review S3: the terminals' audit rows through the REAL audit log keep their ids (terminal, workspace, project; the conn for an
// attach), and nothing else: a path, the shell, the environment or data that a caller slipped into a payload is not stored.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AuditLog, openDatabase } from "@axis/audit";
import { TERMINALS_PAYLOAD_ALLOWLIST, attachTerminal, closeTerminal, openTerminal } from "../../src/terminals/service.js";
import { FakeHandle } from "./fakes.js";
import { serviceRig } from "./service-rig.js";

test("open, attach and close rows keep exactly their ids through the real audit log", async () => {
  const db = openDatabase(":memory:");
  const log = new AuditLog(db, { payloadAllowlist: TERMINALS_PAYLOAD_ALLOWLIST });
  const r = serviceRig({ audit: (e) => void log.append(e) });
  const p = openTerminal(r.deps, { workspaceId: "ws1", cols: 80, rows: 24 }, r.context());
  for (let i = 0; i < 1000 && r.port.spawns.length === 0; i++) await new Promise((res) => setImmediate(res));
  const h = new FakeHandle();
  r.port.spawns[0]?.resolve(h);
  await p;
  attachTerminal(r.deps, h.terminalId, "conn-7", r.context());
  closeTerminal(r.deps, h.terminalId);
  const rows = log.list({ limit: 10 }).map((e) => [e.action, e.target, e.payload]);
  assert.deepEqual(rows, [
    ["terminal.open", `terminal:${h.terminalId}`, { terminalId: h.terminalId, workspaceId: "ws1", projectId: "p1" }],
    ["terminal.attach", `terminal:${h.terminalId}`, { terminalId: h.terminalId, conn: "conn-7" }],
    ["terminal.close", `terminal:${h.terminalId}`, { terminalId: h.terminalId, workspaceId: "ws1", projectId: "p1" }],
  ]);
  // A field outside the allow-list (a path, the shell, the environment) is never stored: only the count of what was left out.
  log.append({ actor: "user", action: "terminal.open", target: "terminal:x", outcome: "success", payload: { terminalId: "x", workspaceId: "w", projectId: "p", cwd: "/home/u/secret", shell: "/bin/zsh", env: { A: "b" } } });
  const last = log.list({ limit: 10 }).at(-1)?.payload;
  assert.deepEqual(last, { terminalId: "x", workspaceId: "w", projectId: "p", _omitted: 3 });
  assert.equal(JSON.stringify(last).includes("secret") || JSON.stringify(last).includes("zsh"), false);
  db.close();
});
