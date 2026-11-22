// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// axis.agents/1 and axis.agent-groups/1 (PV-G2): planned, never served; launch references only; closed refusals.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AGENTS_REASONS,
  AGENTS_REFUSALS,
  agentGroupsMethods,
  agentsMethods,
  contracts,
  isAgentsRefusal,
  lookupMethod,
  lookupMethodIn,
  plannedContracts,
  tableProblems,
} from "../src/index.js";
import { AGENTS_SAMPLES, cliAgent, composerAgent } from "./samples-agents.js";
import { accepts, rejects, runSuite, schemaOf } from "./suite.js";

runSuite(AGENTS_SAMPLES);

test("both contracts are served (PV-G3), never planned, with the designed method tables", () => {
  for (const key of ["axis.agents/1", "axis.agent-groups/1"]) assert.equal(plannedContracts[key], undefined, key);
  assert.equal(lookupMethod("axis.agents", 1, "create"), agentsMethods.create);
  assert.equal(lookupMethod("axis.agent-groups", 1, "assign"), agentGroupsMethods.assign);
  assert.equal(lookupMethodIn(plannedContracts, "axis.agents", 1, "create"), undefined);
  assert.deepEqual(tableProblems(contracts), []);
  const table = (methods: Record<string, { sideEffect: string; tier: number; idempotency: string }>) =>
    Object.entries(methods).map(([m, s]) => [m, s.sideEffect, s.tier, s.idempotency]);
  assert.deepEqual(table(agentsMethods), [
    ["list", "read", 0, "none"], ["get", "read", 0, "none"], ["create", "write", 2, "required"],
    ["update", "write", 2, "none"], ["archive", "write", 1, "none"], ["restore", "write", 1, "none"],
  ]);
  assert.deepEqual(table(agentGroupsMethods), [
    ["list", "read", 0, "none"], ["create", "write", 1, "required"], ["rename", "write", 1, "none"],
    ["reorder", "write", 1, "none"], ["delete", "write", 1, "none"], ["assign", "write", 2, "none"],
  ]);
});

test("a launch is a reference: no command, path, argument, environment or credential field, and the kind decides the fields", () => {
  const create = schemaOf("axis.agents", "create", "request");
  const base = { projectId: "proj-1", name: "X", home: { existing: "ws-1" } };
  accepts(create, { ...base, launch: { kind: "cli", entryId: "a" } }, "a one-character entry");
  for (const launch of [
    { kind: "cli", entryId: "my-cli", command: "rm -rf /" }, { kind: "cli", entryId: "my-cli", args: ["--yolo"] },
    { kind: "cli", entryId: "my-cli", env: { A: "1" } }, { kind: "cli", entryId: "/usr/bin/claude" }, { kind: "cli", entryId: "My-CLI" },
    { kind: "cli", entryId: "../x" }, { kind: "cli", entryId: "" }, { kind: "cli", entryId: "a".repeat(65) },
    { kind: "cli", connection: "c", modelId: "m", mode: "agent" }, { kind: "composer", entryId: "my-cli" },
    { kind: "composer", connection: "c", modelId: "m", mode: "agent", apiKey: "sk-x" }, { kind: "composer", connection: "c", modelId: "m", mode: "yolo" },
    { kind: "composer", connection: "https://evil.example", modelId: "m", mode: "agent" }, { kind: "composer", connection: "c", modelId: "a b", mode: "agent" },
    { kind: "planner", entryId: "x" },
  ]) rejects(create, { ...base, launch }, JSON.stringify(launch));
  for (const home of [{ path: "/tmp/x" }, { new: { name: "w", path: "/tmp" } }, { existing: "ws-1", new: { name: "w" } }, { new: { name: "w", baseRef: "--upload-pack=x" } }, {}]) {
    rejects(create, { ...base, launch: cliAgent.launch, home }, JSON.stringify(home));
  }
  rejects(create, { ...base, launch: cliAgent.launch, createdBy: "user" }, "the creator is the connection's, never the payload's");
});

test("names: 1 to 64 characters, no edge space, control, bidirectional or line-separator character", () => {
  const rename = schemaOf("axis.agent-groups", "rename", "request");
  for (const name of ["x", "Ünïcødé", "n".repeat(64)]) accepts(rename, { groupId: "g", name }, name);
  for (const name of ["", " a", "a ", "n".repeat(65), "a\u0001b", "a\u007fb", "a‮b", "a⁦b", "a‎b", "a b", "a\nb"]) {
    rejects(rename, { groupId: "g", name }, JSON.stringify(name));
  }
});

test("update changes something; reorder names each group once; assign takes a group or null", () => {
  rejects(schemaOf("axis.agents", "update", "request"), { agentId: "agent-a" }, "nothing to update");
  const reorder = schemaOf("axis.agent-groups", "reorder", "request");
  rejects(reorder, { projectId: "p", order: [] }, "empty");
  rejects(reorder, { projectId: "p", order: ["g1", "g1"] }, "a repeated id");
  rejects(reorder, { projectId: "p", order: Array.from({ length: 101 }, (_, i) => `g${i}`) }, "over the group cap");
  accepts(reorder, { projectId: "p", order: Array.from({ length: 100 }, (_, i) => `g${i}`) }, "at the cap");
  rejects(schemaOf("axis.agent-groups", "assign", "request"), { agentId: "agent-a" }, "the group is required (null ungroups)");
  const list = schemaOf("axis.agents", "list", "response");
  accepts(list, { agents: Array.from({ length: 500 }, () => structuredClone(composerAgent)) }, "at the agent cap");
  rejects(list, { agents: Array.from({ length: 501 }, () => structuredClone(composerAgent)) }, "over the agent cap");
});

test("the refusals are closed and never echo a stored name", () => {
  assert.deepEqual(Object.keys(AGENTS_REFUSALS), ["E_NOT_FOUND", "E_CONFLICT"]);
  assert.equal(new Set(AGENTS_REASONS).size, AGENTS_REASONS.length);
  for (const reason of AGENTS_REASONS) assert.match(reason, /^[a-z][a-z_]*$/);
  assert.equal(isAgentsRefusal("E_CONFLICT", "name_taken"), true);
  assert.equal(isAgentsRefusal("E_NOT_FOUND", "name_taken"), false);
  assert.equal(isAgentsRefusal("E_POLICY_DENIED", "archived"), false);
  assert.equal(isAgentsRefusal("toString", "not_found"), false);
});

test("a group's order is 0 to 9999, as the journal stores it", () => {
  const res = schemaOf("axis.agent-groups", "create", "response");
  const g = { id: "g", projectId: "p", name: "G", createdAt: "2026-11-21T10:00:00.000Z", updatedAt: "2026-11-21T10:00:00.000Z" };
  for (const order of [0, 9999]) accepts(res, { group: { ...g, order } }, `order ${order}`);
  for (const order of [-1, 10000, 1.5]) rejects(res, { group: { ...g, order } }, `order ${order}`);
});
