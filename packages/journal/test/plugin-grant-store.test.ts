// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AuditLog, openDatabase } from "@axis/audit";
import { Journal, PLUGIN_RECORD_ACTION } from "../src/index.js";
import { grantForTests, enableForTests } from "./plugin-grants-for-tests.js";

// The plugin grant store (ticket PV-K1b): user-only writes, ids-only audit, the state the daemon's policy reads.

function setup() {
  const db = openDatabase(":memory:");
  const audit = new AuditLog(db);
  const journal = Journal.open(db, { audit });
  journal.registerProject({ id: "p1", path: "/repo/one", displayName: "One", trusted: false, actor: "user" });
  return { db, audit, journal, plugins: journal.plugins };
}
const records = (audit: AuditLog) => audit.list().filter((e) => e.action === PLUGIN_RECORD_ACTION);

test("add, grant, enable: the state the policy reads; every write is the user's and audited with ids only", () => {
  const { audit, plugins } = setup();
  assert.equal(plugins.state("acme.board", "p1"), undefined);
  plugins.add("acme.board", "p1");
  assert.deepEqual(plugins.state("acme.board", "p1"), { enabled: false, generation: 1, permissions: [] });
  grantForTests(plugins, "acme.board", "p1", "pages.read");
  grantForTests(plugins, "acme.board", "p1", "messages.send");
  enableForTests(plugins, "acme.board", "p1");
  assert.deepEqual(plugins.state("acme.board", "p1"), { enabled: true, generation: 1, permissions: ["messages.send", "pages.read"] });
  const rows = records(audit);
  assert.deepEqual(rows.map((e) => e.payload), [
    { field: "added", pluginId: "acme.board", projectId: "p1" },
    { field: "granted", pluginId: "acme.board", projectId: "p1", permission: "pages.read" },
    { field: "granted", pluginId: "acme.board", projectId: "p1", permission: "messages.send" },
    { field: "enabled", pluginId: "acme.board", projectId: "p1" },
  ]);
  assert.ok(rows.every((e) => e.actor === "user" && e.target === "project:p1"));
});

test("a disable and a revoke each bump the generation; an enable, a repeated switch and a missing revoke do not", () => {
  const { plugins } = setup();
  plugins.add("acme.board", "p1");
  grantForTests(plugins, "acme.board", "p1", "pages.read");
  enableForTests(plugins, "acme.board", "p1");
  enableForTests(plugins, "acme.board", "p1");
  assert.equal(plugins.state("acme.board", "p1")?.generation, 1);
  plugins.setEnabled("acme.board", "p1", false);
  assert.equal(plugins.state("acme.board", "p1")?.generation, 2);
  plugins.setEnabled("acme.board", "p1", false);
  assert.equal(plugins.state("acme.board", "p1")?.generation, 2, "already off");
  assert.equal(plugins.revoke("acme.board", "p1", "pages.read"), true);
  assert.deepEqual(plugins.state("acme.board", "p1"), { enabled: false, generation: 3, permissions: [] });
  assert.equal(plugins.revoke("acme.board", "p1", "pages.read"), false);
  assert.equal(plugins.state("acme.board", "p1")?.generation, 3);
});

test("disabling keeps the grants; the policy refuses while disabled, and enabling again restores them", () => {
  const { plugins } = setup();
  plugins.add("acme.board", "p1");
  grantForTests(plugins, "acme.board", "p1", "pages.read");
  plugins.setEnabled("acme.board", "p1", false);
  assert.deepEqual(plugins.state("acme.board", "p1")?.permissions, ["pages.read"]);
  enableForTests(plugins, "acme.board", "p1");
  assert.deepEqual(plugins.state("acme.board", "p1"), { enabled: true, generation: 1, permissions: ["pages.read"] });
});

test("refusals: an unknown permission, a plugin never added, a grant twice; nothing is written or audited", () => {
  const { audit, plugins } = setup();
  plugins.add("acme.board", "p1");
  const before = records(audit).length;
  assert.throws(() => grantForTests(plugins, "acme.board", "p1", "net:evil.example" as never));
  assert.throws(() => grantForTests(plugins, "other.one", "p1", "pages.read"));
  assert.throws(() => enableForTests(plugins, "other.one", "p1"));
  assert.throws(() => plugins.setEnabled("acme.board", "p1", "yes" as never));
  grantForTests(plugins, "acme.board", "p1", "pages.read");
  assert.throws(() => grantForTests(plugins, "acme.board", "p1", "pages.read"));
  assert.throws(() => plugins.add("acme.board", "p1"));
  assert.equal(records(audit).length, before + 1, "only the one good grant was audited");
});

test("list (PV-K2 K2-g1): the plugins of one project by id, each with its state; empty for a project with none; read only", () => {
  const { journal } = setup();
  journal.registerProject({ id: "p9", path: "/repo/nine", displayName: "Nine", trusted: false, actor: "user" });
  assert.deepEqual(journal.plugins.list("p9"), []);
  journal.plugins.add("zeta.tool", "p9");
  journal.plugins.add("alpha.tool", "p9");
  enableForTests(journal.plugins, "alpha.tool", "p9");
  grantForTests(journal.plugins, "alpha.tool", "p9", "runs.start");
  grantForTests(journal.plugins, "alpha.tool", "p9", "pages.read");
  assert.deepEqual(journal.plugins.list("p9"), [
    { pluginId: "alpha.tool", enabled: true, generation: 1, permissions: ["pages.read", "runs.start"] },
    { pluginId: "zeta.tool", enabled: false, generation: 1, permissions: [] },
  ]);
  assert.deepEqual(journal.plugins.list("nowhere"), []);
});
