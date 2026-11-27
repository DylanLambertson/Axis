// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// axis.tasks/1 (PV-T1 slices 1 and 2a): served; no author, source, hop or trust in any request; closed refusals.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_TASK_BODY_CHARS, TASKS_REASONS, TASKS_REFUSALS, contracts, isTasksRefusal, lookupMethod, lookupMethodIn, plannedContracts, tableProblems, tasksMethods,
} from "../src/index.js";
import { TASKS_SAMPLES, importedTask, userRevision, userTask } from "./samples-tasks.js";
import { accepts, rejects, runSuite, schemaOf } from "./suite.js";

runSuite(TASKS_SAMPLES);

test("the contract is served (PV-T1 slice 2a), no longer planned, with the designed method table", () => {
  assert.ok(contracts["axis.tasks/1"] !== undefined);
  assert.equal(lookupMethod("axis.tasks", 1, "create"), tasksMethods.create);
  assert.equal(lookupMethodIn(plannedContracts, "axis.tasks", 1, "delete"), undefined);
  assert.deepEqual(tableProblems(contracts), []);
  assert.deepEqual(Object.entries(tasksMethods).map(([m, s]) => [m, s.sideEffect, s.tier, s.idempotency]), [
    ["list", "read", 0, "none"], ["get", "read", 0, "none"], ["revisions", "read", 0, "none"], ["create", "write", 1, "required"],
    ["update", "write", 1, "none"], ["setStatus", "write", 1, "none"], ["assign", "write", 1, "none"], ["link", "write", 1, "none"],
    ["unlink", "write", 1, "none"], ["delete", "destructive", 4, "none"],
  ]);
  assert.equal("start" in tasksMethods, false, "Start is slice 2b's, with the run it taints");
});

test("no request names an author, a source, a hop, a trust flag or a command", () => {
  const create = schemaOf("axis.tasks", "create", "request");
  const base = { projectId: "proj-1", title: "T", body: "b" };
  accepts(create, base, "a plain task");
  for (const extra of [{ source: "user" }, { author: { kind: "user" } }, { hop: 0 }, { untrusted: false }, { status: "done" }, { assignee: null }, { prompt: "x" }, { command: "x" }]) {
    rejects(create, { ...base, ...extra }, JSON.stringify(extra));
  }
});

test("bodies, links and assignees are bounded and typed", () => {
  const create = schemaOf("axis.tasks", "create", "request");
  accepts(create, { projectId: "p", title: "T", body: "x".repeat(MAX_TASK_BODY_CHARS) }, "at the body cap");
  rejects(create, { projectId: "p", title: "T", body: "x".repeat(MAX_TASK_BODY_CHARS + 1) }, "over the body cap");
  for (const body of ["a\u0000b", "a\ud800b"]) rejects(create, { projectId: "p", title: "T", body }, JSON.stringify(body));
  const link = schemaOf("axis.tasks", "link", "request");
  for (const l of [{ kind: "pr", target: "0" }, { kind: "pr", target: "01" }, { kind: "pr", target: "12345678901" }, { kind: "url", target: "https://x" }, { kind: "file", target: "a" }, { kind: "page", target: "../x" }]) {
    rejects(link, { taskId: "t", link: l }, JSON.stringify(l));
  }
  const assign = schemaOf("axis.tasks", "assign", "request");
  rejects(assign, { taskId: "t", assignee: { kind: "user" } }, "the user is not an assignee");
  rejects(assign, { taskId: "t" }, "the assignee is required (null clears)");
  const list = schemaOf("axis.tasks", "list", "response");
  accepts(list, { tasks: Array.from({ length: 100 }, () => structuredClone(userTask)), more: true }, "a full page");
  rejects(list, { tasks: Array.from({ length: 101 }, () => structuredClone(userTask)), more: true }, "over a page");
});

test("trust is consistent: only the user's task is trusted, a trusted task has hop 0, the user writes at hop 0", () => {
  const get = schemaOf("axis.tasks", "create", "response");
  rejects(get, { task: { ...importedTask, untrusted: false, hop: 0 } }, "an imported task cannot be trusted");
  rejects(get, { task: { ...userTask, hop: 2 } }, "a trusted task with a hop");
  accepts(get, { task: { ...userTask, untrusted: true, hop: 2 } }, "a user task an agent edited");
  const revs = schemaOf("axis.tasks", "revisions", "response");
  rejects(revs, { revisions: [{ ...userRevision, hop: 1 }] }, "a user revision with a hop");
});

test("delete takes an optional approval; the refusals are closed", () => {
  const del = schemaOf("axis.tasks", "delete", "request");
  accepts(del, { taskId: "t" }, "without an approval");
  rejects(del, { taskId: "t", approval: { challengeId: "x" } }, "a bad approval");
  assert.deepEqual(Object.keys(TASKS_REFUSALS), ["E_NOT_FOUND", "E_INVALID_ARGUMENT", "E_CONFLICT"]);
  assert.equal(new Set(TASKS_REASONS).size, TASKS_REASONS.length);
  assert.equal(isTasksRefusal("E_CONFLICT", "assignee_refused"), true);
  assert.equal(isTasksRefusal("E_NOT_FOUND", "assignee_refused"), false);
  assert.equal(isTasksRefusal("toString", "not_found"), false);
});
