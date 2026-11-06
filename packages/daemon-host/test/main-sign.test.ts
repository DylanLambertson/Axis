// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { test } from "node:test";
import { canonicalJson, type Identity } from "@axis/daemon";
import type { JsonValue } from "@axis/protocol";
import { createAttestationVerifier, signAttestation } from "../src/index.js";
import { attestationText, base64url, signMainAttestation, type MainIdentity } from "../src/main/attest-sign.js";
import { DaemonSupervisor, type DaemonChild } from "../src/supervisor.js";

const hmac = (key: Uint8Array, text: string): Uint8Array => new Uint8Array(createHmac("sha256", key).update(text, "utf8").digest());
const clockAt = (t: number) => ({ now: () => t, monotonic: () => t });

function identity(over: Partial<MainIdentity> = {}): MainIdentity {
  return { connectionId: randomBytes(16).toString("base64url"), windowId: `w${randomBytes(2).readUInt16BE()}`, actorId: "local-user", actor: "user", trusted: randomBytes(1)[0]! > 127, clientKind: "desktop", ...over };
}

test("main's canonical text and MAC are byte-equal to the daemon's for random identities, and the daemon's verifier accepts them", () => {
  for (let i = 0; i < 200; i++) {
    const key = randomBytes(32);
    const id = identity(i % 2 === 0 ? { workspaceId: `ws-${i}` } : {});
    const at = 1_700_000_000_000 + i;
    const mine = signMainAttestation(hmac, key, id, at);
    const theirs = signAttestation(key, id as Identity, at);
    assert.equal(attestationText(mine.identity, at), canonicalJson(["axis.attest/1", mine.identity as unknown as JsonValue, at]));
    assert.equal(mine.mac, theirs.mac);
    assert.deepEqual(mine.identity, theirs.identity);
    const verifier = createAttestationVerifier({ key, clock: clockAt(at) });
    assert.deepEqual(verifier.verify(JSON.parse(JSON.stringify(mine))), { ...id });
    // Any changed field breaks it; another key breaks it.
    assert.equal(verifier.verify({ ...mine, identity: { ...mine.identity, trusted: !id.trusted } }), undefined);
    assert.equal(createAttestationVerifier({ key: randomBytes(32), clock: clockAt(at) }).verify(mine), undefined);
  }
});

test("the text sorts keys by code unit at the identity level and has no whitespace", () => {
  assert.equal(attestationText({ b: "x", a: true, Z: "y" }, 5), '["axis.attest/1",{"Z":"y","a":true,"b":"x"},5]');
});

test("base64url matches Node's for every length", () => {
  for (let n = 0; n < 70; n++) {
    const b = randomBytes(n);
    assert.equal(base64url(b), b.toString("base64url"));
  }
});

test("signing refuses a short key, an unsafe time and a MAC function that does not give 32 bytes", () => {
  assert.throws(() => signMainAttestation(hmac, randomBytes(31), identity(), 1));
  assert.throws(() => signMainAttestation(hmac, randomBytes(32), identity(), -1));
  assert.throws(() => signMainAttestation(hmac, randomBytes(32), identity(), 1.5));
  assert.throws(() => signMainAttestation(() => new Uint8Array(31), randomBytes(32), identity(), 1));
  // No undefined reaches the text: an absent workspace is absent, not `undefined`.
  const s = signMainAttestation(hmac, randomBytes(32), identity({ workspaceId: undefined as unknown as string }), 1);
  assert.equal(Object.hasOwn(s.identity, "workspaceId"), false);
});

// ---- the supervisor's connect ---------------------------------------------------------------------------------------

class Child implements DaemonChild {
  readonly sent: Array<{ m: Record<string, unknown>; transfer: readonly unknown[] | undefined }> = [];
  readonly #msg: Array<(m: unknown) => void> = [];
  readonly #exit: Array<(c: number | null) => void> = [];
  postMessage(m: unknown, transfer?: readonly unknown[]): void {
    this.sent.push({ m: m as Record<string, unknown>, transfer });
  }
  kill(): void {}
  onMessage(h: (m: unknown) => void): () => void {
    this.#msg.push(h);
    return () => void this.#msg.splice(this.#msg.indexOf(h), 1);
  }
  onExit(h: (c: number | null) => void): () => void {
    this.#exit.push(h);
    return () => void this.#exit.splice(this.#exit.indexOf(h), 1);
  }
  say(m: unknown): void {
    for (const h of [...this.#msg]) h(m);
  }
  exit(code: number | null): void {
    for (const h of [...this.#exit]) h(code);
  }
  key(): Buffer {
    const init = this.sent.find((s) => s.m["type"] === "init")!.m["config"] as Record<string, unknown>;
    return Buffer.from(init["attestationKey"] as string, "base64url");
  }
}

function rig(withHmac = true) {
  const children: Child[] = [];
  const keysSeen: Uint8Array[] = [];
  const timers = new Map<number, () => void>();
  let n = 0;
  const sup = new DaemonSupervisor({
    spawn: () => {
      const c = new Child();
      children.push(c);
      return c;
    },
    config: { dataDir: "/d/daemon", worktreeRoot: "/d/worktrees", platform: "linux", logLevel: "info", devDiagnostics: false },
    randomBytes: (k) => randomBytes(k),
    timers: { set: (fn) => (timers.set(++n, fn), n), clear: (h) => void timers.delete(h as number) },
    now: () => 0,
    wallNow: () => 1_000_000,
    ...(withHmac ? { hmacSha256: (key: Uint8Array, text: string) => (keysSeen.push(key), hmac(key, text)) } : {}),
  });
  return { sup, children, keysSeen, fireAll: () => [...timers.values()].forEach((f) => f()) };
}

const ready = { type: "ready", protocolVersion: 1, contracts: [] };

test("connect posts one signed connect with exactly the one port, only while running, and the attestation verifies with the init key", () => {
  const { sup, children } = rig();
  const port = { tag: "port1" };
  sup.start();
  const c = children[0]!;
  assert.equal(sup.connect(identity(), port), false, "not before ready");
  assert.equal(c.sent.filter((s) => s.m["type"] === "connect").length, 0);
  c.say(ready);
  const id = identity();
  assert.equal(sup.connect(id, port), true);
  const sent = c.sent.find((s) => s.m["type"] === "connect")!;
  assert.deepEqual(sent.transfer, [port]);
  assert.deepEqual(Object.keys(sent.m).sort(), ["attestation", "type"]);
  const verifier = createAttestationVerifier({ key: c.key(), clock: clockAt(1_000_000) });
  assert.deepEqual(verifier.verify(sent.m["attestation"]), { ...id });
  // A degraded host is still running and still brokered (it serves its audit reads).
  const { sup: s2, children: ch2 } = rig();
  s2.start();
  ch2[0]!.say({ ...ready, degraded: "anchor_unreachable" });
  assert.equal(s2.connect(identity(), port), true);
});

test("without a MAC function connect always refuses", () => {
  const { sup, children } = rig(false);
  sup.start();
  children[0]!.say(ready);
  assert.equal(sup.connect(identity(), {}), false);
  assert.equal(children[0]!.sent.some((s) => s.m["type"] === "connect"), false);
});

test("the key is zeroed when the child exits, and the restarted child's key is a new one that the old one does not verify", () => {
  const { sup, children, keysSeen, fireAll } = rig();
  sup.start();
  children[0]!.say(ready);
  assert.equal(sup.connect(identity(), {}), true);
  const oldKey = children[0]!.key();
  const held = keysSeen[0]!;
  assert.deepEqual(Buffer.from(held), oldKey, "the MAC was made with the init key");
  children[0]!.exit(1); // a crash
  assert.equal(held.every((b) => b === 0), true, "the held key was zeroed on exit");
  assert.equal(sup.connect(identity(), {}), false, "no key, no connect while restarting");
  fireAll(); // backoff: respawn
  const c2 = children[1]!;
  c2.say(ready);
  assert.notDeepEqual(c2.key(), oldKey);
  assert.equal(sup.connect(identity(), {}), true);
  const att = c2.sent.find((s) => s.m["type"] === "connect")!.m["attestation"];
  assert.equal(createAttestationVerifier({ key: oldKey, clock: clockAt(1_000_000) }).verify(att), undefined);
  assert.ok(createAttestationVerifier({ key: c2.key(), clock: clockAt(1_000_000) }).verify(att));
});

test("after shutdown or a refusal exit there is no key and no connect", async () => {
  const a = rig();
  a.sup.start();
  a.children[0]!.say(ready);
  a.sup.connect(identity(), {});
  const held = a.keysSeen[0]!;
  const stopped = a.sup.shutdown();
  assert.equal(a.sup.connect(identity(), {}), false, "stopping");
  a.children[0]!.exit(0);
  await stopped;
  assert.equal(held.every((b) => b === 0), true);
  const b = rig();
  b.sup.start();
  b.children[0]!.say(ready);
  b.sup.connect(identity(), {});
  b.children[0]!.exit(78);
  assert.equal(b.sup.state(), "failed");
  assert.equal(b.keysSeen[0]!.every((x) => x === 0), true);
  assert.equal(b.sup.connect(identity(), {}), false);
});
