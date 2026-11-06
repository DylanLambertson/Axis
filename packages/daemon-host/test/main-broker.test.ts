// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { identitySchema } from "@axis/daemon";
import type { MainIdentity } from "../src/main/attest-sign.js";
import { ConnectBroker, isWorkbenchFrame, type ConnectBrokerOptions, type ConnectSender } from "../src/main/connect-broker.js";

const WB = "vscode-file://vscode-app/opt/axis/resources/app/out/vs/code/electron-browser/workbench/workbench.html";
const good: ConnectSender = { codeWindowId: 3, frameUrl: WB, isMainFrame: true, destroyed: false };

interface Port {
  readonly name: string;
  closed: boolean;
}

function rig(over: Partial<ConnectBrokerOptions<Port>> = {}, accept = true) {
  let now = 0;
  let pairs = 0;
  const made: Port[] = [];
  const connects: Array<{ identity: MainIdentity; port: unknown }> = [];
  const events: string[] = [];
  const broker = new ConnectBroker<Port>({
    supervisor: { connect: (identity, port) => (connects.push({ identity, port }), accept) },
    createChannel: () => {
      pairs++;
      const d = { name: `d${pairs}`, closed: false };
      const r = { name: `r${pairs}`, closed: false };
      made.push(d, r);
      return { daemonEnd: d, rendererEnd: r };
    },
    closePort: (p) => void (p.closed = true),
    randomBytes: (n) => randomBytes(n),
    workbenchUrls: [WB],
    windowTrusted: (id) => id === 3,
    now: () => now,
    onEvent: (e, r) => void events.push(r === undefined ? e : `${e}:${r}`),
    ...over,
  });
  return { broker, made, connects, events, tick: (ms: number) => void (now += ms) };
}

test("a good sender gets the renderer end; the daemon end goes to the supervisor with a main-built user identity", () => {
  const { broker, connects, made, events } = rig();
  const out = broker.connect(good, "2f1c-aa");
  assert.equal(out.ok, true);
  assert.ok(out.ok);
  assert.equal(out.port, made[1]);
  assert.equal(out.windowId, "w3");
  assert.equal(connects.length, 1);
  assert.equal(connects[0]!.port, made[0]);
  const id = connects[0]!.identity;
  assert.deepEqual({ ...id, connectionId: "x" }, { connectionId: "x", windowId: "w3", actorId: "local-user", actor: "user", trusted: true, clientKind: "desktop" });
  assert.equal(identitySchema.safeParse(id).success, true, "the daemon's identity schema accepts it");
  assert.equal(id.connectionId.length, 22);
  assert.equal(broker.codeWindowOf("w3"), 3);
  assert.deepEqual(events, ["connected"]);
  // Two connects never share a connection id.
  broker.connect(good, "n2");
  assert.notEqual(connects[1]!.identity.connectionId, id.connectionId);
});

test("every sender check refuses in order with a closed reason, and no port or connect is made", () => {
  const cases: Array<[ConnectSender, unknown, string]> = [
    [good, 7, "bad_nonce"],
    [good, "", "bad_nonce"],
    [good, "a".repeat(65), "bad_nonce"],
    [good, "has space", "bad_nonce"],
    [{ ...good, codeWindowId: undefined }, "n", "not_code_window"],
    [{ ...good, codeWindowId: -1 }, "n", "not_code_window"],
    [{ ...good, frameUrl: "about:blank" }, "n", "bad_frame"],
    [{ ...good, frameUrl: "" }, "n", "bad_frame"],
    [{ ...good, frameUrl: undefined }, "n", "bad_frame"],
    [{ ...good, frameUrl: WB.replace("workbench.html", "workbench-dev.html") }, "n", "bad_frame"],
    [{ ...good, isMainFrame: false }, "n", "not_main_frame"],
    [{ ...good, destroyed: true }, "n", "destroyed"],
    // A frame check before the main frame check: an about:blank subframe is refused for its URL.
    [{ ...good, frameUrl: "about:blank", isMainFrame: false }, "n", "bad_frame"],
  ];
  for (const [sender, nonce, reason] of cases) {
    const { broker, made, connects } = rig();
    const out = broker.connect(sender, nonce);
    assert.deepEqual(out, { ok: false, reason }, `${reason} for ${JSON.stringify(sender)} ${String(nonce)}`);
    assert.equal(made.length, 0);
    assert.equal(connects.length, 0);
  }
});

test("the window's trust is main's answer, and a throwing trust lookup is untrusted", () => {
  const a = rig({ windowTrusted: () => false });
  a.broker.connect(good, "n");
  assert.equal(a.connects[0]!.identity.trusted, false);
  const b = rig({
    windowTrusted: () => {
      throw new Error("x");
    },
  });
  assert.equal(b.broker.connect(good, "n").ok, true);
  assert.equal(b.connects[0]!.identity.trusted, false);
  const c = rig({ windowTrusted: () => "yes" as unknown as boolean });
  c.broker.connect(good, "n");
  assert.equal(c.connects[0]!.identity.trusted, false, "only true is trusted");
});

test("a supervisor that is not ready, a channel that cannot be made or a short random source closes both ends", () => {
  const a = rig({}, false);
  assert.deepEqual(a.broker.connect(good, "n"), { ok: false, reason: "not_ready" });
  assert.deepEqual(a.made.map((p) => p.closed), [true, true]);
  assert.equal(a.broker.codeWindowOf("w3"), undefined, "a refused window is not in the table");
  const b = rig({ randomBytes: () => new Uint8Array(15) });
  assert.deepEqual(b.broker.connect(good, "n"), { ok: false, reason: "not_ready" });
  assert.equal(b.connects.length, 0);
  assert.deepEqual(b.made.map((p) => p.closed), [true, true]);
  const c = rig({
    createChannel: () => {
      throw new Error("no");
    },
  });
  assert.deepEqual(c.broker.connect(good, "n"), { ok: false, reason: "not_ready" });
});

test("per-window rate limit: a burst of 5, then about one per 6 s; another window has its own bucket", () => {
  const { broker, tick } = rig();
  for (let i = 0; i < 5; i++) assert.equal(broker.connect(good, `n${i}`).ok, true);
  assert.deepEqual(broker.connect(good, "x"), { ok: false, reason: "rate_limited" });
  assert.equal(broker.connect({ ...good, codeWindowId: 4 }, "y").ok, true);
  tick(5_999);
  assert.deepEqual(broker.connect(good, "x"), { ok: false, reason: "rate_limited" });
  tick(1);
  assert.equal(broker.connect(good, "x").ok, true);
  assert.deepEqual(broker.connect(good, "x"), { ok: false, reason: "rate_limited" });
});

test("the bucket table is bounded: a full table drops a refilled bucket, never an exhausted one, and refuses when none is refilled", () => {
  const { broker, tick } = rig({ maxWindows: 2 });
  for (let i = 0; i < 5; i++) broker.connect({ ...good, codeWindowId: 1 }, "n");
  broker.connect({ ...good, codeWindowId: 2 }, "n");
  assert.deepEqual(broker.connect({ ...good, codeWindowId: 9 }, "n"), { ok: false, reason: "rate_limited" }, "no refilled bucket to drop");
  tick(6_000); // window 2 is full again, window 1 is not
  assert.equal(broker.connect({ ...good, codeWindowId: 9 }, "n").ok, true);
  assert.equal(broker.connect({ ...good, codeWindowId: 1 }, "n").ok, true, "window 1 kept its bucket (one token refilled)");
  assert.deepEqual(broker.connect({ ...good, codeWindowId: 1 }, "n"), { ok: false, reason: "rate_limited" });
});

test("a closed window leaves the table", () => {
  const { broker } = rig();
  broker.connect(good, "n");
  broker.windowClosed(3);
  assert.equal(broker.codeWindowOf("w3"), undefined);
});

test("isWorkbenchFrame: same scheme, host and path only", () => {
  assert.equal(isWorkbenchFrame(`${WB}?x=1#y`, [WB]), true);
  for (const bad of [
    WB.replace("vscode-file:", "file:"),
    WB.replace("vscode-app", "vscode-app2"),
    WB.replace("vscode-app", "u:p@vscode-app"),
    WB.replace("vscode-app", "vscode-app:99"),
    WB.replace("workbench.html", "other.html"),
    `${WB}/x`,
    "vscode-file://vscode-app/opt/axis/resources/app/out/vs/sessions/electron-browser/sessions.html",
    "not a url",
    "about:blank",
  ]) {
    assert.equal(isWorkbenchFrame(bad, [WB]), false, bad);
  }
  assert.equal(isWorkbenchFrame(WB, ["::"]), false, "an unparsable expected URL matches nothing");
  assert.equal(isWorkbenchFrame(WB, []), false);
});
