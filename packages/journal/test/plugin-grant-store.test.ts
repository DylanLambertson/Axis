// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AuditLog, openDatabase } from "@axis/audit";
import { Journal, PLUGIN_RECORD_ACTION } from "../src/index.js";

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
  plugins.grant("acme.board", "p1", "pages.read");
  plugins.grant("acme.board", "p1", "messages.send");
  plugins.setEnabled("acme.board", "p1", true);
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
  plugins.grant("acme.board", "p1", "pages.read");
  plugins.setEnabled("acme.board", "p1", true);
  plugins.setEnabled("acme.board", "p1", true);
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
  plugins.grant("acme.board", "p1", "pages.read");
  plugins.setEnabled("acme.board", "p1", false);
  assert.deepEqual(plugins.state("acme.board", "p1")?.permissions, ["pages.read"]);
  plugins.setEnabled("acme.board", "p1", true);
  assert.deepEqual(plugins.state("acme.board", "p1"), { enabled: true, generation: 1, permissions: ["pages.read"] });
});

test("refusals: an unknown permission, a plugin never added, a grant twice; nothing is written or audited", () => {
  const { audit, plugins } = setup();
  plugins.add("acme.board", "p1");
  const before = records(audit).length;
  assert.throws(() => plugins.grant("acme.board", "p1", "net:evil.example" as never));
  assert.throws(() => plugins.grant("other.one", "p1", "pages.read"));
  assert.throws(() => plugins.setEnabled("other.one", "p1", true));
  assert.throws(() => plugins.setEnabled("acme.board", "p1", "yes" as never));
  plugins.grant("acme.board", "p1", "pages.read");
  assert.throws(() => plugins.grant("acme.board", "p1", "pages.read"));
  assert.throws(() => plugins.add("acme.board", "p1"));
  assert.equal(records(audit).length, before + 1, "only the one good grant was audited");
});
