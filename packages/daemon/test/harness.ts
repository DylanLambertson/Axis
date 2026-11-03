// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { MessagePort } from "node:worker_threads";
import { z } from "zod";
import type { MethodSpec } from "@axis/protocol";
import {
  Daemon,
  MemoryIdempotencyStore,
  memoryPair,
  type ApprovalGate,
  type ContractRegistry,
  type DaemonAuditEvent,
  type DaemonOptions,
  type Identity,
  type IdentityVerifier,
  type Policy,
} from "../src/index.js";

export const CONTRACT = "axis.test";

const echoReq = z.strictObject({ text: z.string().max(1_000_000) });
const approvalRef = z.strictObject({ challengeId: z.string().regex(/^[A-Za-z0-9_-]{22,64}$/) });

export const testMethods: Record<string, MethodSpec> = {
  echo: { request: echoReq, response: echoReq, sideEffect: "read", tier: 0, idempotency: "none", timeoutMs: 1000 },
  slow: { request: z.strictObject({}), response: z.strictObject({}), sideEffect: "read", tier: 0, idempotency: "none", timeoutMs: 120 },
  write: {
    request: z.strictObject({ n: z.number() }),
    response: z.strictObject({ n: z.number() }),
    sideEffect: "write",
    tier: 2,
    idempotency: "required",
    timeoutMs: 1000,
  },
  optional: {
    request: z.strictObject({ n: z.number() }),
    response: z.strictObject({ n: z.number() }),
    sideEffect: "write",
    tier: 2,
    idempotency: "optional",
    timeoutMs: 1000,
  },
  danger: {
    request: z.strictObject({ id: z.string(), approval: approvalRef.optional() }),
    response: z.strictObject({ done: z.literal(true) }),
    sideEffect: "destructive",
    tier: 4,
    idempotency: "required",
    timeoutMs: 1000,
  },
  boom: { request: z.strictObject({}), response: z.strictObject({}), sideEffect: "read", tier: 0, idempotency: "none", timeoutMs: 1000 },
  leaky: { request: z.strictObject({}), response: z.strictObject({ ok: z.boolean() }), sideEffect: "read", tier: 0, idempotency: "none", timeoutMs: 1000 },
  unhandled: { request: z.strictObject({}), response: z.strictObject({}), sideEffect: "read", tier: 0, idempotency: "none", timeoutMs: 1000 },
};

export const testRegistry: ContractRegistry = {
  lookup: (c, v, m) => (c === CONTRACT && (v === 1 || v === 2) && Object.hasOwn(testMethods, m) ? testMethods[m] : undefined),
  versions: (c) => (c === CONTRACT ? [1, 2] : []),
};

/** Connection ids are 22+ base64url characters (minted by main); tests use readable names padded to that. */
export const cid = (name: string): string => name.padEnd(22, "_");

export const identityOf = (over: Partial<Identity> = {}): Identity => ({
  connectionId: cid("conn-1"),
  windowId: "win-1",
  actorId: "actor-1",
  actor: "user",
  trusted: true,
  clientKind: "desktop",
  ...over,
});

/**
 * Accepts "good[:<actorId>][#<connectionId>][@<workspaceId>][~<windowId>]", refuses
 * everything else. The connection id defaults to conn-1, so a second
 * connection that must not be refused as a duplicate names its own.
 */
export const verifier: IdentityVerifier = {
  verify(att) {
    if (typeof att !== "string" || !att.startsWith("good")) return undefined;
    const [noWin, windowId] = att.split("~");
    const [rest, workspaceId] = (noWin as string).split("@");
    const [head, conn] = (rest as string).split("#");
    const actorId = (head as string).split(":")[1];
    return identityOf({
      ...(actorId ? { actorId } : {}),
      ...(conn ? { connectionId: cid(conn) } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      ...(windowId ? { windowId } : {}),
    });
  },
};

export const allowAll: Policy = { evaluate: () => ({ effect: "allow" }) };

export class Inbox {
  readonly all: unknown[] = [];
  #waiters: Array<() => void> = [];
  closed = false;
  constructor(port: MessagePort) {
    port.on("message", (m) => {
      this.all.push(m);
      this.#waiters.splice(0).forEach((w) => w());
    });
    port.on("close", () => {
      this.closed = true;
      this.#waiters.splice(0).forEach((w) => w());
    });
  }
  async until<T>(pred: (m: unknown) => m is T, ms = 1500): Promise<T> {
    const deadline = Date.now() + ms;
    for (;;) {
      const hit = this.all.find(pred);
      if (hit !== undefined) return hit;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timed out waiting for message; got ${JSON.stringify(this.all).slice(0, 400)}`);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, left);
        this.#waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }
  response(id: string, ms?: number): Promise<{ id: string; ok: boolean; result?: unknown; error?: { code: string; message: string; details?: Record<string, unknown> } }> {
    return this.until((m): m is never => typeof m === "object" && m !== null && (m as { id?: unknown }).id === id, ms) as never;
  }
  async closedWithin(ms = 1000): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (!this.closed && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    return this.closed;
  }
}

export const hello = (over: Record<string, unknown> = {}) => ({
  type: "hello",
  protocolVersions: [1],
  contracts: [{ id: CONTRACT, versions: [1] }],
  ...over,
});

export const req = (id: string, method: string, payload: unknown = {}, over: Record<string, unknown> = {}) => ({
  v: 1,
  id,
  contract: CONTRACT,
  contractVersion: 1,
  method,
  payload,
  ...over,
});

export const KEY1 = "00000000-0000-4000-8000-000000000001";
export const KEY2 = "00000000-0000-4000-8000-000000000002";

export interface Rig {
  daemon: Daemon;
  client: MessagePort;
  inbox: Inbox;
  events: DaemonAuditEvent[];
  internal: Array<{ correlationId: string; error: unknown }>;
  send(m: unknown): void;
  connect(attestation: unknown): { client: MessagePort; inbox: Inbox };
  handshake(over?: Record<string, unknown>): Promise<unknown>;
  cleanup(): void;
}

export function rig(options: Partial<DaemonOptions> & { gate?: ApprovalGate; attestation?: unknown; noPolicy?: boolean } = {}): Rig {
  const events: DaemonAuditEvent[] = [];
  const internal: Array<{ correlationId: string; error: unknown }> = [];
  const ports: MessagePort[] = [];
  const { gate, attestation, noPolicy, ...rest } = options;
  const daemon = new Daemon({
    identity: verifier,
    audit: { append: (e) => void events.push(e) },
    registry: testRegistry,
    idempotency: new MemoryIdempotencyStore(),
    ...(noPolicy ? {} : { policy: allowAll }),
    ...(gate ? { approvals: gate } : {}),
    onInternalError: (correlationId, error) => void internal.push({ correlationId, error }),
    ...rest,
  });
  const connect = (att: unknown) => {
    const { client, server } = memoryPair();
    ports.push(client);
    const inbox = new Inbox(client);
    daemon.accept(server, att);
    return { client, inbox };
  };
  const first = connect("attestation" in options ? attestation : "good");
  return {
    daemon,
    client: first.client,
    inbox: first.inbox,
    events,
    internal,
    send: (m) => first.client.postMessage(m),
    connect,
    async handshake(over) {
      first.client.postMessage(hello(over));
      return first.inbox.until((m): m is { type: string } => typeof m === "object" && m !== null && "type" in m && (m as { type: string }).type !== undefined);
    },
    cleanup() {
      daemon.stop();
      for (const p of ports) p.close();
    },
  };
}
