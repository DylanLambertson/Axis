// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Main's plugin views (ticket PV-K1d, ADR 0008 decisions 3 and 5).
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { test } from "node:test";
import { identitySchema } from "@axis/daemon";
import { createAttestationVerifier } from "../src/index.js";
import { signMainAttestation, type MainIdentity, type MainPluginIdentity } from "../src/main/attest-sign.js";
import { PluginViews, type PluginViewEvent } from "../src/main/plugin-views.js";

interface FakePort {
  readonly id: number;
  closed: boolean;
}

function rig(over: { live?: (id: number) => boolean; connect?: (identity: MainIdentity) => boolean; perHost?: number; max?: number } = {}) {
  const identities: MainPluginIdentity[] = [];
  const events: PluginViewEvent[] = [];
  let next = 0;
  const views = new PluginViews<FakePort>({
    supervisor: { connect: (identity) => (identities.push(identity), over.connect?.(identity) ?? true) },
    createChannel: () => ({ daemonEnd: { id: next++, closed: false }, rendererEnd: { id: next++, closed: false } }),
    closePort: (p) => void (p.closed = true),
    randomBytes: (n) => new Uint8Array(randomBytes(n)),
    hostLive: over.live ?? (() => true),
    onEvent: (e) => events.push(e),
    ...(over.perHost === undefined ? {} : { maxViewsPerHost: over.perHost }),
    ...(over.max === undefined ? {} : { maxViews: over.max }),
  });
  return { views, identities, events };
}

const req = (wc: number, host = 3, pluginId = "acme.board", projectId = "proj-1") => ({ hostCodeWindowId: host, webContentsId: wc, pluginId, projectId });

test("mint signs a plugin identity: p<n>, the host's w<n>, the project, trusted false, a fresh connection id", () => {
  const { views, identities } = rig();
  const a = views.mint(req(100));
  const b = views.mint(req(101));
  assert.equal(a.ok && a.windowId, "p1");
  assert.equal(b.ok && b.windowId, "p2");
  assert.deepEqual(
    identities.map(({ connectionId, ...rest }) => (assert.match(connectionId, /^[A-Za-z0-9_-]{22}$/), rest)),
    [1, 2].map((n) => ({ windowId: `p${n}`, actorId: "plugin:acme.board", actor: "plugin:acme.board", workspaceId: "proj-1", trusted: false, clientKind: "plugin", hostWindowId: "w3" })),
  );
  assert.notEqual(identities[0]?.connectionId, identities[1]?.connectionId);
});

test("the minted identity passes the daemon's signer and verifier as a plugin, never as the user", () => {
  const { views, identities } = rig();
  views.mint(req(100));
  const key = randomBytes(32);
  const hmac = (k: Uint8Array, t: string) => new Uint8Array(createHmac("sha256", k).update(t, "utf8").digest());
  const att = signMainAttestation(hmac, key, identities[0] as MainIdentity, 5);
  const verified = createAttestationVerifier({ key, clock: { now: () => 5, monotonic: () => 5 } }).verify(JSON.parse(JSON.stringify(att)));
  assert.ok(verified !== undefined);
  const parsed = identitySchema.parse(verified);
  assert.equal(parsed?.actor, "plugin:acme.board");
  assert.equal(parsed?.clientKind, "plugin");
  assert.notEqual(parsed?.actor, "user");
});

test("p<n> ids are never reused: not after a destroy, a reload or a failed connect", () => {
  let fail = false;
  const { views } = rig({ connect: () => !fail });
  const ids: string[] = [];
  const take = (r: ReturnType<typeof views.mint>) => r.ok && ids.push(r.windowId);
  take(views.mint(req(100)));
  views.destroy(100);
  take(views.mint(req(101)));
  take(views.reload(101, req(102)));
  fail = true;
  assert.deepEqual(views.mint(req(103)), { ok: false, reason: "not_ready" });
  fail = false;
  take(views.mint(req(104)));
  assert.deepEqual(ids, ["p1", "p2", "p3", "p5"], "the failed attempt used p4 and it is not handed out again");
});

test("a failed connect closes both ends and records nothing", () => {
  const { views } = rig({ connect: () => false });
  assert.deepEqual(views.mint(req(100)), { ok: false, reason: "not_ready" });
  assert.equal(views.isPluginSender(100), false);
});

test("bad input is refused with a closed reason before anything is made", () => {
  const { views, identities } = rig();
  const cases: Array<[unknown, string]> = [
    [req(100, 3, "Acme"), "bad_plugin"],
    [req(100, 3, "a".repeat(65)), "bad_plugin"],
    [req(100, 3, "acme.board", ""), "bad_project"],
    [req(100, 3, "acme.board", "x".repeat(65)), "bad_project"],
    [req(-1), "bad_view"],
    [req(1.5), "bad_view"],
    [req(100, -1), "host_not_live"],
    [null, "bad_view"],
  ];
  for (const [r, reason] of cases) assert.deepEqual(views.mint(r as never), { ok: false, reason }, JSON.stringify(r));
  assert.equal(identities.length, 0);
});

test("a host that is not live, or was destroyed, cannot mint: a stale window id stays dead", () => {
  const notLive = rig({ live: () => false });
  assert.deepEqual(notLive.views.mint(req(100)), { ok: false, reason: "host_not_live" });
  const throwing = rig({ live: () => { throw new Error("x"); } });
  assert.deepEqual(throwing.views.mint(req(100)), { ok: false, reason: "host_not_live" });
  const { views } = rig();
  assert.equal(views.mint(req(100)).ok, true);
  views.destroyHost(3);
  assert.deepEqual(views.mint(req(101)), { ok: false, reason: "host_not_live" }, "the host reports live, but it was destroyed");
  assert.equal(views.mint(req(102, 4)).ok, true, "another window still can");
});

test("destroying a host closes every view it hosts and only those", () => {
  const { views } = rig();
  const a = views.mint(req(100, 3));
  const b = views.mint(req(101, 3));
  const c = views.mint(req(102, 4));
  views.destroyHost(3);
  assert.equal(a.ok && a.port.closed, true);
  assert.equal(b.ok && b.port.closed, true);
  assert.equal(c.ok && c.port.closed, false);
  assert.equal(views.isPluginSender(100), false);
  assert.equal(views.isPluginSender(102), true);
});

test("a reload is a new view with a new port and id; a reload under another host or of an unknown view is refused", () => {
  const { views, identities } = rig();
  const first = views.mint(req(100));
  const again = views.reload(100, req(101));
  assert.equal(first.ok && first.port.closed, true, "the old port is closed");
  assert.equal(again.ok && again.windowId, "p2");
  assert.notEqual(identities[0]?.connectionId, identities[1]?.connectionId);
  assert.deepEqual(views.reload(101, req(102, 9)), { ok: false, reason: "bad_view" }, "a view cannot move to another window");
  assert.deepEqual(views.reload(555, req(103)), { ok: false, reason: "bad_view" });
  assert.equal(views.isPluginSender(101), true, "the refused reload left the view alone");
});

test("a webContents id already in use is refused", () => {
  const { views } = rig();
  views.mint(req(100));
  assert.deepEqual(views.mint(req(100)), { ok: false, reason: "bad_view" });
});

test("bounded: 8 views per host and 64 in all, with closed refusals; a destroy frees a place", () => {
  const per = rig();
  for (let i = 0; i < 8; i++) assert.equal(per.views.mint(req(100 + i)).ok, true);
  assert.deepEqual(per.views.mint(req(200)), { ok: false, reason: "host_full" });
  per.views.destroy(100);
  assert.equal(per.views.mint(req(200)).ok, true);
  const all = rig({ perHost: 64 });
  for (let i = 0; i < 64; i++) assert.equal(all.views.mint(req(100 + i, i % 5)).ok, true);
  assert.deepEqual(all.views.mint(req(999, 9)), { ok: false, reason: "views_full" });
});

test("IPC from a plugin view is dropped silently: one event per view and channel, then only counted; other senders pass", () => {
  const { views, events } = rig();
  views.mint(req(100));
  views.mint(req(101));
  for (const ch of ["vscode:axisConnect", "vscode:axisConnect", "vscode:hello", "unknown", "vscode:axisConnect"]) assert.equal(views.dropIpc(100, ch), true);
  assert.equal(views.dropIpc(101, "vscode:axisConnect"), true);
  assert.equal(views.dropIpc(7, "vscode:axisConnect"), false, "a code window's renderer is not a plugin view");
  assert.equal(events.filter((e) => e.event === "plugin_ipc_dropped").length, 4, "three channels of one view, one of the other");
  assert.equal(views.droppedCount(100), 5);
  assert.ok(!JSON.stringify(events).includes("vscode:") && !JSON.stringify(events).includes("acme"), "no channel or name in an event");
  for (let i = 0; i < 100; i++) views.dropIpc(100, `ch-${i}`);
  assert.ok(events.filter((e) => e.event === "plugin_ipc_dropped").length <= 4 + 32, "the per-view channel memory is bounded");
  views.destroy(100);
  assert.equal(views.dropIpc(100, "x"), false, "a destroyed view's id is no longer a plugin sender");
});

test("OI-7: the module offers no way to list views, windows or plugins", () => {
  const methods = Object.getOwnPropertyNames(PluginViews.prototype).filter((m) => m !== "constructor").sort();
  assert.deepEqual(methods, ["destroy", "destroyHost", "dropIpc", "droppedCount", "isPluginSender", "mint", "reload"]);
  for (const m of methods) assert.doesNotMatch(m, /list|all|each|enumerate|entries|keys/i);
});
