// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// PV-K2 K2-g4b: the composed host feeds the host windows' lifetimes from the daemon's session lifecycle (a real desktop session
// over a transferred port) and from main's `window.gone` on the control channel.
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { test } from "node:test";
import type { ElectronPortLike } from "@axis/daemon";
import type { GitRunner } from "@axis/git-ops";
import { composeDaemonHost, type ComposeOptions, type PtyPort } from "../src/index.js";
import { signMainAttestation } from "../src/main/attest-sign.js";
import type { WindowLifetimes } from "../src/plugins/window-lifetimes.js";
import { hostFixture } from "../testing/host-fixture.js";
import { Client } from "./approvals-rig.js";
import { until } from "./plugin-start-rig.js";

const pty: PtyPort = { spawn: () => Promise.reject(new Error("unused")) };
const runner: GitRunner = { run: () => Promise.reject(new Error("unused")) };
const snapshotter: NonNullable<ComposeOptions["snapshotter"]> = () => ({ before: () => Promise.resolve(), after: () => Promise.resolve({ drift: false }) });
const hmac = (key: Uint8Array, text: string): Uint8Array => new Uint8Array(createHmac("sha256", key).update(text, "utf8").digest());

/** A node port behind the Electron port shape the connect router takes. */
function electronLike(p: MessagePort): ElectronPortLike {
  return {
    on(event: "message" | "close", listener: (...args: unknown[]) => void) {
      if (event === "message") p.on("message", (data: unknown) => listener({ data, ports: [] }));
      else p.on("close", () => listener());
      return this;
    },
    postMessage: (m: unknown) => p.postMessage(m),
    start: () => p.start(),
    close: () => p.close(),
  } as ElectronPortLike;
}

test("a desktop session starts its window's lifetime, its close ends it, and main's window.gone ends one still attached", async () => {
  const fix = hostFixture();
  const { control: _control, ...ports } = fix.ports as typeof fix.ports & { control: unknown };
  let lifetimes: Pick<WindowLifetimes, "current" | "status"> | undefined;
  let onPort: ((data: unknown, port: ElectronPortLike) => void) | undefined;
  const composed = composeDaemonHost({
    config: fix.config, control: fix.client, ports, pty, ptyGitRunner: runner, snapshotter, process: new EventEmitter(), exit: () => undefined,
    portSource: { onPort: (h) => ((onPort = h), () => undefined) },
    observeWindowLifetimes: (l) => (lifetimes = l),
  });
  const open: MessagePort[] = [];
  const connect = async (windowId: string): Promise<Client> => {
    const { port1, port2 } = new MessageChannel();
    open.push(port1);
    const identity = { connectionId: randomBytes(16).toString("base64url"), windowId, actorId: "local-user", actor: "user" as const, trusted: false, clientKind: "desktop" as const };
    (onPort as (data: unknown, port: ElectronPortLike) => void)({ type: "connect", attestation: signMainAttestation(hmac, fix.config.attestationKey, identity, Date.now()) }, electronLike(port2));
    const c = new Client(port1 as never);
    await c.hello();
    return c;
  };
  try {
    await composed.start();
    const l = lifetimes as Pick<WindowLifetimes, "current" | "status">;
    assert.equal(l.current("w5"), undefined);
    const first = await connect("w5");
    await until(() => l.current("w5") !== undefined, "the accepted session");
    const epoch = l.current("w5") as string;
    // window.gone from main (the supervisor's side of the control channel) ends it although the session is still open.
    fix.peer.send({ type: "window.gone", windowId: "w5" });
    await until(() => l.current("w5") === undefined, "window.gone");
    assert.equal(l.status("w5", epoch), "ended");
    // A malformed one is refused by the control schema and changes nothing.
    const second = await connect("w6");
    await until(() => l.current("w6") !== undefined, "w6 accepted");
    fix.peer.send({ type: "window.gone", windowId: "p6" });
    fix.peer.send({ type: "window.gone", windowId: "w6", extra: 1 });
    await new Promise((r) => setTimeout(r, 20));
    assert.notEqual(l.current("w6"), undefined);
    // The session's close, reported by the daemon's lifecycle, ends its window's lifetime.
    second.port.close();
    await until(() => l.current("w6") === undefined, "w6's last close");
    first.port.close();
  } finally {
    for (const p of open) p.close();
    await composed.stop();
    fix.cleanup();
  }
});
