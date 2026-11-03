// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { AuditLog, type DatabaseSync } from "@axis/audit";
import { Journal } from "../../src/index.js";

/** A scripted lifecycle shared by the crashing child and the in-process reference. */
export interface Ctx {
  ws: string;
  r1: string;
  r2: string;
  ws2: string;
}

export function deterministicJournal(db: DatabaseSync): { journal: Journal; audit: AuditLog } {
  let n = 0;
  let tick = 0;
  const audit = new AuditLog(db, { now: () => new Date(Date.UTC(2026, 10, 2, 0, 0, 0) + 1000 * 1000) });
  const journal = Journal.open(db, {
    audit,
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
    now: () => new Date(Date.UTC(2026, 10, 2, 0, 0, 0) + 1000 * ++tick),
  });
  return { journal, audit };
}

export const STEPS: ReadonlyArray<(j: Journal, c: Ctx) => void> = [
  (j, c) => {
    c.ws = j.createWorkspace({ projectId: "p1", branch: "axis/demo", baseRef: "main", baseSha: "a".repeat(40), createdBy: "user" }).value.id;
  },
  (j, c) => void j.transitionWorkspace(c.ws, "READY"),
  (j, c) => {
    c.r1 = j.createRun({ workspaceId: c.ws, kind: "cli", createdBy: "user" }).value.id;
  },
  (j, c) => void j.transitionRun(c.r1, "RUNNING"),
  (j, c) => {
    c.r2 = j.createRun({ workspaceId: c.ws, kind: "composer", createdBy: "user" }).value.id;
  },
  (j, c) => void j.transitionRun(c.r2, "RUNNING"),
  (j, c) => void j.transitionRun(c.r1, "REVIEWING"),
  (j, c) => void j.transitionRun(c.r2, "BLOCKED", { reason: "USER_PAUSED" }),
  (j, c) => void j.transitionRun(c.r1, "COMPLETED", { exitCode: 0, actor: "user" }),
  (j, c) => void j.transitionRun(c.r2, "RUNNING"),
  // a second workspace walks into REMOVING, the state recovery must report but not rewrite
  (j, c) => {
    c.ws2 = j.createWorkspace({ projectId: "p2", branch: "axis/other", baseRef: "main", baseSha: "c".repeat(40), createdBy: "user" }).value.id;
  },
  (j, c) => void j.transitionWorkspace(c.ws2, "READY"),
  (j, c) => void j.transitionWorkspace(c.ws2, "REMOVING", { reason: "USER_REMOVED", actor: "user" }),
];

export function snapshot(j: Journal): unknown {
  return {
    workspaces: j.listWorkspaces({ includeRemoved: true }).map((w) => [w.id, w.state]),
    runs: j.listRuns().map((r) => [r.id, r.kind, r.state, r.reason]),
  };
}
