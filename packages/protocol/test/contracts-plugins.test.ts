// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// axis.plugins/1 (PV-K2 slice K2-g1): list, revoke and disable only; no method can add a permission or switch a plugin on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_PROJECT_PLUGINS, PLUGIN_PERMISSION_NAMES, contracts, lookupMethod, pluginsMethods } from "../src/index.js";
import { accepts, rejects, schemaOf } from "./suite.js";

const entry = (over: Record<string, unknown> = {}) => ({ pluginId: "acme.board", enabled: true, generation: 1, permissions: ["pages.read", "runs.start"], ...over });

test("served with exactly list, revoke and disable: no grant and no enable (K2-g2), so nothing here is an increase", () => {
  assert.ok(contracts["axis.plugins/1"] !== undefined);
  assert.deepEqual(Object.keys(pluginsMethods).sort(), ["disable", "list", "revoke"]);
  for (const m of ["grant", "enable", "install", "update"]) assert.equal(lookupMethod("axis.plugins", 1, m), undefined, m);
  assert.deepEqual([...PLUGIN_PERMISSION_NAMES], ["agents.read", "messages.send", "tasks.read", "tasks.write", "pages.read", "pages.write", "runs.start", "files.read"]);
});

test("requests: the project and the plugin by id, the permission from the closed set, nothing else", () => {
  const list = schemaOf("axis.plugins", "list", "request");
  const revoke = schemaOf("axis.plugins", "revoke", "request");
  const disable = schemaOf("axis.plugins", "disable", "request");
  accepts(list, { projectId: "p1" }, "list");
  rejects(list, {}, "list without a project");
  accepts(revoke, { projectId: "p1", pluginId: "acme.board", permission: "runs.start" }, "revoke");
  for (const bad of ["net:example.com", "integration:x", "admin", "Runs.start", ""]) rejects(revoke, { projectId: "p1", pluginId: "acme.board", permission: bad }, bad);
  for (const id of ["Acme", "acme..board", `a${"b".repeat(64)}`, "", "acme/board"]) rejects(revoke, { projectId: "p1", pluginId: id, permission: "runs.start" }, id);
  accepts(disable, { projectId: "p1", pluginId: "acme.board" }, "disable");
  for (const k of ["actor", "generation", "enabled", "windowId", "approval"]) {
    rejects(disable, { projectId: "p1", pluginId: "acme.board", [k]: "x" }, k);
    rejects(revoke, { projectId: "p1", pluginId: "acme.board", permission: "runs.start", [k]: "x" }, k);
  }
});

test("responses: sorted unique permissions, a generation of at least 1, unique plugins, at most 64", () => {
  const list = schemaOf("axis.plugins", "list", "response");
  const change = schemaOf("axis.plugins", "revoke", "response");
  accepts(list, { plugins: [entry(), entry({ pluginId: "other.tool", enabled: false, permissions: [] })] }, "two plugins");
  rejects(list, { plugins: [entry(), entry()] }, "a duplicate plugin");
  rejects(list, { plugins: Array.from({ length: MAX_PROJECT_PLUGINS + 1 }, (_, i) => entry({ pluginId: `p${i}` })) }, "65 plugins");
  accepts(list, { plugins: Array.from({ length: MAX_PROJECT_PLUGINS }, (_, i) => entry({ pluginId: `p${i}` })) }, "64 plugins");
  rejects(change, { plugin: entry({ permissions: ["runs.start", "pages.read"] }) }, "unsorted");
  rejects(change, { plugin: entry({ permissions: ["pages.read", "pages.read"] }) }, "repeated");
  rejects(change, { plugin: entry({ generation: 0 }) }, "generation 0");
  rejects(change, { plugin: entry({ generation: 1.5 }) }, "fractional generation");
  rejects(change, { plugin: entry({ token: "x" }) }, "extra key");
  accepts(change, { plugin: entry() }, "change");
});
