// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The plugin identity (ADR 0008 decision 3, ticket PV-K1a): what a verifier may hand back for a plugin view, and what no other
// identity may carry.
import assert from "node:assert/strict";
import { test } from "node:test";
import { identitySchema } from "../src/index.js";

const PLUGIN = Object.freeze({
  connectionId: "A".repeat(22),
  windowId: "p7",
  actorId: "plugin:acme.board",
  actor: "plugin:acme.board",
  workspaceId: "proj-1",
  trusted: false,
  clientKind: "plugin",
  hostWindowId: "w3",
});
const WINDOW = Object.freeze({ connectionId: "B".repeat(22), windowId: "w3", actorId: "local-user", actor: "user", trusted: true, clientKind: "desktop" });
const ok = (v: unknown): boolean => identitySchema.safeParse(v).success;

test("a plugin identity with every field in place is accepted, and a window identity still is", () => {
  assert.equal(ok(PLUGIN), true);
  assert.equal(ok({ ...PLUGIN, actor: `plugin:${"a".repeat(64)}`, actorId: `plugin:${"a".repeat(64)}` }), true, "a 64-character id");
  assert.equal(ok({ ...PLUGIN, actor: "plugin:a.b-c.d.e", actorId: "plugin:a.b-c.d.e" }), true, "four words");
  assert.equal(ok(WINDOW), true);
  assert.equal(ok({ ...WINDOW, clientKind: "web", windowId: "web" }), true);
});

test("a plugin identity missing or bending any rule is refused", () => {
  const bad: Array<[string, Record<string, unknown>]> = [
    ["actorId differs", { actorId: "plugin:other" }],
    ["actorId is the user's", { actorId: "local-user" }],
    ["desktop kind", { clientKind: "desktop" }],
    ["web kind", { clientKind: "web" }],
    ["code window id", { windowId: "w7" }],
    ["web window id", { windowId: "web" }],
    ["no host window", { hostWindowId: undefined }],
    ["host is a plugin view", { hostWindowId: "p1" }],
    ["host is the web", { hostWindowId: "web" }],
    ["no project", { workspaceId: undefined }],
    ["id too long", { actor: `plugin:${"a".repeat(65)}`, actorId: `plugin:${"a".repeat(65)}` }],
    ["five words", { actor: "plugin:a.b.c.d.e", actorId: "plugin:a.b.c.d.e" }],
    ["upper case", { actor: "plugin:Acme", actorId: "plugin:Acme" }],
    ["empty id", { actor: "plugin:", actorId: "plugin:" }],
    ["digit first", { actor: "plugin:1a", actorId: "plugin:1a" }],
    ["empty word", { actor: "plugin:a..b", actorId: "plugin:a..b" }],
    ["non-ASCII letter", { actor: "plugin:acm\u00e9", actorId: "plugin:acm\u00e9" }],
    ["Cyrillic look-alike", { actor: "plugin:\u0430cme", actorId: "plugin:\u0430cme" }],
    ["NUL", { actor: "plugin:acme\u0000", actorId: "plugin:acme\u0000" }],
    ["trailing newline", { actor: "plugin:acme\n", actorId: "plugin:acme\n" }],
    ["user actor", { actor: "user", actorId: "local-user" }],
    ["a plugin actorId on another plugin", { actorId: "plugin:acme.boards" }],
  ];
  for (const [name, over] of bad) {
    const v: Record<string, unknown> = { ...PLUGIN, ...over };
    for (const k of Object.keys(v)) if (v[k] === undefined) delete v[k];
    assert.equal(ok(v), false, name);
  }
});

test("no other identity may carry a plugin view's window or a host window", () => {
  assert.equal(ok({ ...WINDOW, windowId: "p3" }), false, "a desktop identity on a p<n> window");
  assert.equal(ok({ ...WINDOW, hostWindowId: "w1" }), false, "a desktop identity with a host window");
  assert.equal(ok({ ...WINDOW, clientKind: "web", windowId: "web", hostWindowId: "w1" }), false, "a web identity with a host window");
  assert.equal(ok({ ...WINDOW, actor: "plugin:acme", actorId: "plugin:acme" }), false, "a plugin actor on a desktop identity");
  assert.equal(ok({ ...WINDOW, actor: "plugin:acme" }), false, "a plugin actor on a desktop identity with the user's actorId");
  assert.equal(ok({ ...PLUGIN, actor: "agent:x", actorId: "agent:x" }), false, "a non-plugin actor of kind plugin with every other plugin field");
  assert.equal(ok({ ...WINDOW, actorId: "plugin:acme" }), false, "a plugin actorId under the user's actor (it would share a plugin's idempotency keys)");
  assert.equal(ok({ ...WINDOW, actor: "agent:r1", actorId: "r1", clientKind: "plugin", windowId: "p1", hostWindowId: "w1", workspaceId: "p" }), false, "a non-plugin actor of kind plugin");
});
