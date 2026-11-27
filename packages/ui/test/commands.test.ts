// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CommandRegistry, type KeyContext, type KeyGesture } from "../src/index.js";

const ctx = (extra: Partial<KeyContext> = {}): KeyContext => ({ platform: "other", activeScopes: [], inEditable: false, ...extra });
const key = (k: string, extra: Partial<KeyGesture> = {}): KeyGesture => ({ key: k, code: /^[a-z]$/i.test(k) ? `Key${k.toUpperCase()}` : k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...extra });

test("register refuses a bad or taken id and a chord already taken in the same scope", () => {
  const r = new CommandRegistry();
  r.register({ id: "axis.palette.open", title: "Open command palette", chord: "Mod+K", run: () => {} });
  assert.throws(() => r.register({ id: "axis.palette.open", title: "x", run: () => {} }), /already registered/);
  assert.throws(() => r.register({ id: "Palette", title: "x", run: () => {} }), /not a command id/);
  assert.throws(() => r.register({ id: "axis.other.one", title: "x", chord: "Mod+K", run: () => {} }), /taken in global/);
  assert.throws(() => r.register({ id: "axis.other.two", title: "x", chord: "Mod+k", run: () => {} }), /not a chord/);
  r.register({ id: "axis.list.open", title: "Open", chord: "Mod+K", scope: "dashboard-list", run: () => {} });
});

test("resolve: exact chord, active scope wins over global, inactive scopes and disabled commands are skipped", () => {
  const r = new CommandRegistry();
  let enabled = true;
  r.register({ id: "axis.palette.open", title: "Palette", chord: "Mod+K", run: () => {} });
  r.register({ id: "axis.list.kill", title: "List", chord: "Mod+K", scope: "dashboard-list", enabled: () => enabled, run: () => {} });
  assert.equal(r.resolve(key("k", { ctrlKey: true }), ctx())?.id, "axis.palette.open");
  assert.equal(r.resolve(key("k", { ctrlKey: true }), ctx({ activeScopes: ["dashboard-list"] }))?.id, "axis.list.kill");
  enabled = false;
  assert.equal(r.resolve(key("k", { ctrlKey: true }), ctx({ activeScopes: ["dashboard-list"] }))?.id, "axis.palette.open");
  assert.equal(r.resolve(key("k", { metaKey: true }), ctx()), undefined, "Meta+K is not Mod+K off macOS");
  assert.equal(r.resolve(key("k", { metaKey: true }), ctx({ platform: "mac" }))?.id, "axis.palette.open");
});

test("a bare-letter chord never fires while typing; a Mod chord or F6 still does", () => {
  const r = new CommandRegistry();
  r.register({ id: "axis.workspace.new", title: "New workspace", chord: "N", scope: "dashboard-list", run: () => {} });
  r.register({ id: "axis.region.next", title: "Next region", chord: "F6", run: () => {} });
  r.register({ id: "axis.palette.open", title: "Palette", chord: "Mod+K", run: () => {} });
  const inList = ctx({ activeScopes: ["dashboard-list"] });
  assert.equal(r.resolve(key("n"), inList)?.id, "axis.workspace.new");
  assert.equal(r.resolve(key("n"), { ...inList, inEditable: true }), undefined);
  assert.equal(r.resolve(key("F6"), ctx({ inEditable: true }))?.id, "axis.region.next");
  assert.equal(r.resolve(key("k", { ctrlKey: true }), ctx({ inEditable: true }))?.id, "axis.palette.open");
});

test("run, list and the remover", () => {
  const r = new CommandRegistry();
  const ran: string[] = [];
  const remove = r.register({ id: "axis.b.cmd", title: "Beta", run: () => ran.push("b") });
  r.register({ id: "axis.a.cmd", title: "Alpha", enabled: () => false, run: () => ran.push("a") });
  assert.deepEqual(r.list().map((c) => c.title), ["Alpha", "Beta"]);
  assert.equal(r.run("axis.a.cmd"), false, "disabled");
  assert.equal(r.run("axis.b.cmd"), true);
  assert.equal(r.run("axis.none.cmd"), false);
  assert.deepEqual(ran, ["b"]);
  remove();
  remove();
  assert.equal(r.get("axis.b.cmd"), undefined);
  r.register({ id: "axis.b.cmd", title: "Beta again", run: () => {} });
  remove();
  assert.equal(r.get("axis.b.cmd")?.title, "Beta again", "a stale remover does not remove a newer command");
});
