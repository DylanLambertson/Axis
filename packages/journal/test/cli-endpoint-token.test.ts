// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// PV-M7 slice 2 (axis-messages-shim.md section 7; the K2-g3 pattern): turning the CLI endpoint switch ON needs a single-use
// token of the serving store, whose mint the store hands out once; turning it off needs none.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AuditLog, openDatabase } from "@axis/audit";
import { Journal, type CliEndpointSwitchWrite } from "../src/index.js";

function setup() {
  const db = openDatabase(":memory:");
  return { db, journal: Journal.open(db, { audit: new AuditLog(db) }) };
}
type Detailed = { detail?: { reason?: string }; details?: { reason?: string } };
const reasonOf = (e: unknown): string | undefined => (e as Detailed).detail?.reason ?? (e as Detailed).details?.reason;
const refusedToken = (e: unknown): boolean => reasonOf(e) === "token";

test("the switch mint is handed out once; a second take throws", () => {
  const { journal } = setup();
  assert.equal(typeof journal.cliEndpoint.takeSwitchMint(), "function");
  assert.throws(() => journal.cliEndpoint.takeSwitchMint(), (e: unknown) => reasonOf(e) === "mint_taken");
});

test("switching on needs a token of this store, spent once (even when it changes nothing); switching off needs none", () => {
  const { journal } = setup();
  const mint = journal.cliEndpoint.takeSwitchMint();
  const token = mint();
  assert.deepEqual(journal.cliEndpoint.switchOn(token), { changed: true });
  assert.throws(() => journal.cliEndpoint.switchOn(token), refusedToken, "a spent token");
  assert.throws(() => journal.cliEndpoint.switchOn(undefined as unknown as CliEndpointSwitchWrite), refusedToken, "no token");
  assert.throws(() => journal.cliEndpoint.switchOn(Object.freeze(Object.create(null)) as CliEndpointSwitchWrite), refusedToken, "a forged look-alike");
  const again = mint();
  assert.deepEqual(journal.cliEndpoint.switchOn(again), { changed: false }, "a repeat with a fresh token changes nothing");
  assert.throws(() => journal.cliEndpoint.switchOn(again), refusedToken, "and that token is spent too");
  assert.deepEqual(journal.cliEndpoint.switchOff(), { changed: true });
  assert.equal(journal.cliEndpoint.enabled(), false);
});

test("a token is a frozen object with no prototype", () => {
  const token = setup().journal.cliEndpoint.takeSwitchMint()() as unknown as Record<string, unknown>;
  assert.equal(Object.isFrozen(token), true);
  assert.equal(Object.getPrototypeOf(token), null);
  assert.deepEqual(Reflect.ownKeys(token), []);
});

test("a token of another store, or a plugin grant token, is refused", () => {
  const a = setup();
  const b = setup();
  a.journal.cliEndpoint.takeSwitchMint();
  assert.throws(() => a.journal.cliEndpoint.switchOn(b.journal.cliEndpoint.takeSwitchMint()()), refusedToken, "another store's");
  assert.throws(() => a.journal.cliEndpoint.switchOn(a.journal.plugins.takeGrantMint()() as unknown as CliEndpointSwitchWrite), refusedToken, "a grant token");
  assert.equal(a.journal.cliEndpoint.enabled(), false);
});

test("RESIDUAL pinned (as K2-g3's): a second journal over the SAME database has its own mint and can switch on", () => {
  const { db, journal } = setup();
  journal.cliEndpoint.takeSwitchMint();
  const second = Journal.open(db, { audit: new AuditLog(db) });
  second.cliEndpoint.switchOn(second.cliEndpoint.takeSwitchMint()());
  assert.equal(journal.cliEndpoint.enabled(), true, "code that holds the database handle is in the trusted base");
});
