// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// PV-K2 K2-g3: the journal alone makes grant tokens. Each store hands its mint out once; a grant or an enable needs a token of that
// store, spent before the write. A second store over the same database is the recorded residual (plugin-grant-contract.md 8.4).
import assert from "node:assert/strict";
import { test } from "node:test";
import { AuditLog, openDatabase } from "@axis/audit";
import { Journal, type PluginGrantWrite } from "../src/index.js";

function setup() {
  const db = openDatabase(":memory:");
  const journal = Journal.open(db, { audit: new AuditLog(db) });
  journal.registerProject({ id: "p1", path: "/repo/one", displayName: "One", trusted: false, actor: "user" });
  journal.plugins.add("acme.board", "p1");
  return { db, journal };
}
const refusedToken = (e: unknown): boolean => (e as { detail?: { reason?: string }; details?: { reason?: string } }).detail?.reason === "token" || (e as { details?: { reason?: string } }).details?.reason === "token";

test("the mint is handed out once; a second take throws", () => {
  const { journal } = setup();
  const mint = journal.plugins.takeGrantMint();
  assert.equal(typeof mint, "function");
  assert.throws(() => journal.plugins.takeGrantMint(), (e: unknown) => JSON.stringify(e).includes("mint_taken") || String((e as Error).message).includes("already taken"));
});

test("a grant or an enable needs a token of this store, spent once; a disable needs none", () => {
  const { journal } = setup();
  const mint = journal.plugins.takeGrantMint();
  const token = mint();
  journal.plugins.grant("acme.board", "p1", "runs.start", token);
  assert.deepEqual(journal.plugins.state("acme.board", "p1")?.permissions, ["runs.start"]);
  assert.throws(() => journal.plugins.grant("acme.board", "p1", "pages.read", token), refusedToken, "a spent token");
  assert.throws(() => journal.plugins.grant("acme.board", "p1", "pages.read", undefined as unknown as PluginGrantWrite), refusedToken, "no token");
  assert.throws(() => journal.plugins.grant("acme.board", "p1", "pages.read", Object.freeze(Object.create(null)) as PluginGrantWrite), refusedToken, "a forged look-alike");
  assert.throws(() => journal.plugins.setEnabled("acme.board", "p1", true), refusedToken, "an enable without a token");
  assert.deepEqual(journal.plugins.state("acme.board", "p1"), { enabled: false, generation: 1, permissions: ["runs.start"] }, "nothing else was written");
  journal.plugins.setEnabled("acme.board", "p1", true, mint());
  journal.plugins.setEnabled("acme.board", "p1", false); // a decrease: no token
  assert.equal(journal.plugins.state("acme.board", "p1")?.enabled, false);
});

test("a token of another store is refused, even over a database of the same shape", () => {
  const a = setup();
  const b = setup();
  const fromB = b.journal.plugins.takeGrantMint()();
  a.journal.plugins.takeGrantMint();
  assert.throws(() => a.journal.plugins.grant("acme.board", "p1", "runs.start", fromB), refusedToken);
  assert.deepEqual(a.journal.plugins.state("acme.board", "p1")?.permissions, []);
});

test("RESIDUAL pinned (plugin-grant-contract.md 8.4, decision 4): a second journal over the SAME database has its own mint and can grant", () => {
  const { db, journal } = setup();
  journal.plugins.takeGrantMint(); // the serving journal's mint is taken, as the host does at startup
  const second = Journal.open(db, { audit: new AuditLog(db) });
  // The guarantee stops at the serving store: code that holds the database handle is in the trusted base. If a per-database
  // authority (option (a)) is chosen later, this test flips and the register row closes.
  second.plugins.grant("acme.board", "p1", "runs.start", second.plugins.takeGrantMint()());
  assert.deepEqual(journal.plugins.state("acme.board", "p1")?.permissions, ["runs.start"], "the serving store reads the row");
  assert.throws(() => journal.plugins.takeGrantMint(), "the serving store's own take still throws, so its startup check never sees this");
});
