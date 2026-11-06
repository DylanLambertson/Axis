// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { test } from "node:test";
import type { ElectronPortLike } from "@axis/daemon";
import { resolveGit } from "@axis/git-ops";
import { welcomeSchema } from "@axis/protocol";
import { runDaemonEntry, type DaemonEntryDeps } from "../src/entry.js";
import { EXIT, signAttestation, type Attestation } from "../src/index.js";
import { FakeParentPort, FakeProcess, FakeTimers, initPayload, platformName, sandbox } from "../testing/entry-harness.js";
import { LocalPty, localPtyGitRunner } from "../testing/fake-pty.js";
import { gitSkipReason } from "../testing/git-fixture.js";

/** A MessageChannel whose server end looks like Electron's `MessagePortMain`. The client end is the renderer's. */
function portPair(): { client: MessagePort; server: ElectronPortLike } {
  const { port1, port2 } = new MessageChannel();
  const server: ElectronPortLike = {
    on: ((event: string, listener: (...a: never[]) => void) => (event === "message" ? port2.on("message", (data: unknown) => (listener as (e: unknown) => void)({ data, ports: [] })) : port2.on("close", listener as () => void))) as ElectronPortLike["on"],
    postMessage: (m) => port2.postMessage(m),
    start: () => port2.start(),
    close: () => port2.close(),
  };
  return { client: port1, server };
}

const skip = gitSkipReason();

test("with every port supplied the entry starts, serves an attested connection over a transferred port, refuses a forged one, and ends by draining on `shutdown`", { skip }, async () => {
  const box = sandbox();
  const port = new FakeParentPort();
  const proc = new FakeProcess();
  const lines: string[] = [];
  const env = { PATH: process.env["PATH"] ?? "", HOME: box.root };
  const gitPath = resolveGit(env, process.platform);
  assert.ok(gitPath, "git was found");
  port.reply = (m, deliver) => {
    if (m["type"] === "anchor.get") deliver({ type: "anchor.result", requestId: m["requestId"], anchor: null });
    if (m["type"] === "anchor.put") deliver({ type: "anchor.ack", seq: m["seq"] });
  };
  const timers = new FakeTimers();
  const deps: DaemonEntryDeps = {
    timers,
    parentPort: port,
    process: proc,
    env,
    cwd: box.root,
    platform: platformName(),
    execArgv: [],
    stderr: (l) => void lines.push(l),
    // TEST ONLY stand-ins for the ports that do not exist yet (pty process B9): never reachable from the overlay entry.
    ports: { pty: new LocalPty(), ptyGitRunner: localPtyGitRunner(gitPath, env) },
  };
  const open: MessagePort[] = [];
  try {
    const h = runDaemonEntry(deps);
    const init = initPayload(box);
    port.deliver(init.message);
    // A second init while startup is still pending is ignored (design step 2): read, it would be an invalid configuration and end the host.
    port.deliver(initPayload(box, { platform: "nonsense" }).message);
    assert.equal(await h.started, true, lines.join("\n"));
    // The init timer is gone once init arrived: a timer that were still armed would stop this healthy host with exit 78.
    assert.equal(timers.pending(), 0, "no init timer is left armed");
    timers.fire();
    assert.equal(port.posted.some((m) => m["type"] === "fatal"), false, "a healthy host is not stopped by the init timeout");
    const ready = port.posted.find((m) => m["type"] === "ready");
    assert.ok(ready, "ready was sent");
    assert.equal(ready["degraded"], undefined);

    const attest = (key: Uint8Array): Attestation =>
      signAttestation(key, { connectionId: randomBytes(16).toString("base64url"), windowId: "win-1", actorId: "person-1", actor: "user", trusted: true, clientKind: "desktop" }, Date.now());
    const hello = { type: "hello", protocolVersions: [1], contracts: [{ id: "axis.projects", versions: [1] }] };

    // A genuine connection: the connect message carries one port; the host answers hello with welcome.
    const good = portPair();
    open.push(good.client);
    const first = once(good.client, "message");
    port.deliver({ type: "connect", attestation: attest(init.key) }, [good.server]);
    good.client.postMessage(hello);
    const [answer] = await first;
    assert.equal(welcomeSchema.safeParse(answer).success, true, JSON.stringify(answer));

    // A connection attested with another key is rejected and closed.
    const forged = portPair();
    open.push(forged.client);
    const answers: unknown[] = [];
    forged.client.on("message", (m) => void answers.push(m));
    const closed = once(forged.client, "close");
    port.deliver({ type: "connect", attestation: attest(Buffer.alloc(32, 7)) }, [forged.server]);
    forged.client.postMessage(hello);
    await closed;
    assert.equal(answers.some((m) => welcomeSchema.safeParse(m).success), false, "no welcome for a forged attestation");
    assert.ok(answers.every((m) => (m as { type?: string }).type === "hello-rejected"), JSON.stringify(answers));

    // Two ports in one message, or none for a connect: nothing is accepted (a port message must carry exactly one port).
    const a = portPair();
    const b = portPair();
    open.push(a.client, b.client);
    const aClosed = once(a.client, "close");
    port.deliver({ type: "connect", attestation: attest(init.key) }, [a.server, b.server]);
    await aClosed;

    // `shutdown` on the control channel ends the host by draining: exit 0 and no `process.exit`.
    port.deliver({ type: "shutdown" });
    assert.equal(await h.finished, EXIT.OK, lines.join("\n"));
    assert.deepEqual(proc.exits, [], "the process ended by draining, not by exit()");
    assert.equal(port.attached(), false);
    for (const name of proc.eventNames()) assert.equal(proc.listenerCount(name), 0, `a listener on ${String(name)} was left behind`);
    assert.equal(JSON.stringify([...lines, ...port.posted]).includes(init.key.toString("base64url")), false, "the key reached no line and no message");
  } finally {
    for (const p of open) p.close();
    box.cleanup();
  }
});
