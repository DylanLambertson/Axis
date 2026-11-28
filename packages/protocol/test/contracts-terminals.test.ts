// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// axis.terminals/1 (DC-3a): planned until DC-3c; no path, command or environment in any request; ids are the pty process's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { contracts, lookupMethod, lookupMethodIn, plannedContracts, tableProblems, terminalsMethods } from "../src/index.js";

const ok = (schema: { safeParse(v: unknown): { success: boolean } }, v: unknown): boolean => schema.safeParse(v).success;
const TID = "pty_0123456789abcdef0123456789abcdef";

test("planned, not served: the planned table has it at its tiers, and a lookup in the served table finds nothing", () => {
  assert.equal(contracts["axis.terminals/1"], undefined);
  assert.equal(lookupMethod("axis.terminals", 1, "open"), undefined);
  assert.equal(lookupMethodIn(plannedContracts, "axis.terminals", 1, "open")?.tier, 2);
  assert.deepEqual(tableProblems(plannedContracts), []);
});

test("open takes a workspace id and a size only: never a path, a shell, a command or an environment", () => {
  const req = terminalsMethods.open.request;
  assert.equal(ok(req, { workspaceId: "ws1", cols: 80, rows: 24 }), true);
  for (const extra of [{ cwd: "/tmp" }, { shell: "/bin/sh" }, { argv: ["/bin/sh"] }, { env: {} }]) assert.equal(ok(req, { workspaceId: "ws1", cols: 80, rows: 24, ...extra }), false, JSON.stringify(extra));
  for (const [cols, rows] of [[0, 24], [80, 1001], [1.5, 24]]) assert.equal(ok(req, { workspaceId: "ws1", cols, rows }), false, `${cols}x${rows}`);
  assert.equal(ok(req, { workspaceId: "../ws", cols: 80, rows: 24 }), false);
});

test("terminal ids are pty_ and 32 lower-case hex characters; a conn is a plain name", () => {
  const attach = terminalsMethods.attach.request;
  assert.equal(ok(attach, { terminalId: TID, conn: "c-1_x" }), true);
  for (const terminalId of ["pty_0123", TID.toUpperCase(), `${TID}0`, "x".repeat(36)]) assert.equal(ok(attach, { terminalId, conn: "c1" }), false, terminalId);
  for (const conn of ["", "-c", "c/1", "c 1", "c".repeat(65)]) assert.equal(ok(attach, { terminalId: TID, conn }), false, conn);
  assert.equal(ok(terminalsMethods.close.request, { terminalId: TID }), true);
});

test("a listed terminal is closed in shape, and a list never repeats an id", () => {
  const t = { terminalId: TID, workspaceId: "ws1", projectId: "p1", kind: "plain", runId: null, state: "open" };
  const list = terminalsMethods.list.response;
  assert.equal(ok(list, { terminals: [t] }), true);
  assert.equal(ok(list, { terminals: [t, t] }), false);
  assert.equal(ok(list, { terminals: [{ ...t, state: "reopened" }] }), false);
  assert.equal(ok(list, { terminals: [{ ...t, path: "/w" }] }), false);
});
