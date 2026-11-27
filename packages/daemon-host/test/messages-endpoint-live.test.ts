// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// PV-M7 slice 2, part 2 (axis-messages-shim.md section 7): the CLI endpoint switch is live. Turning it on wires the relay in a
// running host without a restart; turning it off revokes every live endpoint at once (each close sent on the pty channel) and
// unwires the relay; on again wires it again. The switch handlers call it after their write commits.
import assert from "node:assert/strict";
import { test } from "node:test";
import { cliEndpointLive, hostCliSwitch, type RelayIn, type RelayOut } from "../src/index.js";

function fakes() {
  const subscribed: number[] = [];
  const sent: RelayOut[] = [];
  let handler: ((m: RelayIn) => void) | undefined;
  let flushed = 0;
  const live = new Set<string>();
  const relay = {
    onRelay: async (): Promise<readonly RelayOut[]> => [],
    mint: (runId: string) => (live.add(runId), { endpointId: `ep_${runId}`, token: "t" }),
    revoke: (runId: string): RelayOut | undefined => (live.delete(runId) ? { t: "endpoint-close", endpoint: `ep_${runId}`, reason: "revoked" } : undefined),
    revokeAll: (): RelayOut[] => {
      const out = [...live].map((r): RelayOut => ({ t: "endpoint-close", endpoint: `ep_${r}`, reason: "revoked" }));
      live.clear();
      return out;
    },
    revokeWorker: () => [],
    dropPaused: () => [],
    flush: () => void flushed++,
  };
  const port = {
    onRelay: (h: (m: RelayIn) => void) => (subscribed.push(1), (handler = h), { dispose: () => void (handler = undefined) }),
    relay: (m: RelayOut) => (sent.push(m), true),
  };
  return { relay, port, sent, subscribed, handler: () => handler, flushed: () => flushed, live };
}

test("off at start: nothing is wired; on wires the relay without a restart; off revokes every live endpoint at once and unwires; on again wires again", () => {
  const f = fakes();
  const cleanups: (() => void)[] = [];
  const live = cliEndpointLive(f.port, { relay: f.relay as never, source: Symbol("pty-control") }, cleanups);
  assert.equal(live.current(), undefined, "off: no endpoints");
  live.on();
  const wired = live.current();
  assert.ok(wired !== undefined, "on: wired");
  assert.equal(f.subscribed.length, 1);
  assert.ok(f.handler() !== undefined, "the relay subscription is live");
  live.on();
  assert.equal(f.subscribed.length, 1, "on twice wires once");
  wired.mint("r1");
  wired.mint("r2");
  live.off();
  assert.deepEqual(f.sent.map((o) => o.t === "endpoint-close" && o.endpoint).sort(), ["ep_r1", "ep_r2"], "each live endpoint closed on the channel at once");
  assert.equal(live.current(), undefined, "off: unwired");
  assert.equal(f.handler(), undefined, "the relay subscription is disposed");
  assert.equal(f.flushed(), 1, "the pending aggregated rows are written as it unwires");
  live.off();
  assert.equal(f.sent.length, 2, "off twice revokes nothing more");
  live.on();
  assert.ok(live.current() !== undefined, "on again");
  assert.equal(f.subscribed.length, 2);
  cleanups.forEach((c) => c());
  assert.equal(f.handler(), undefined, "shutdown unwires");
});

test("a pty port that does not relay is never wired, on or off", () => {
  const f = fakes();
  const live = cliEndpointLive({}, { relay: f.relay as never, source: Symbol("pty-control") }, []);
  live.on();
  assert.equal(live.current(), undefined);
  assert.doesNotThrow(() => live.off());
});

test("the host's switch deps: a committed enable calls on, a committed disable calls off", () => {
  const calls: string[] = [];
  const deps = hostCliSwitch({
    action: { switchOn: () => ({ changed: true }) },
    store: { enabled: () => false, switchOff: () => ({ changed: true }) },
    live: { on: () => void calls.push("on"), off: () => void calls.push("off"), current: () => undefined },
    platform: "linux",
    onPreview: () => undefined,
  });
  deps.onChanged?.(true);
  deps.onChanged?.(false);
  assert.deepEqual(calls, ["on", "off"]);
});
