// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { randomUUID } from "node:crypto";
import type { MessagePort } from "node:worker_threads";
import { z } from "zod";
import type { ChallengeAuditEvent } from "@axis/challenge";
import {
  Daemon,
  MemoryIdempotencyStore,
  memoryPair,
  protocolRegistry,
  type ContractRegistry,
  type DaemonAuditEvent,
  type Handler,
  type Identity,
  type IdentityVerifier,
  type Policy,
} from "@axis/daemon";
import type { Challenge, MethodSpec } from "@axis/protocol";
import {
  ChannelMux,
  ControlClient,
  createApprovals,
  createApprovalsHandlers,
  InMemoryTrustRegistry,
  RULES,
  RuleTablePolicy,
  userRule,
  type Approvals,
  type ChallengeLimits,
} from "../src/index.js";
import { memoryChannelPair, type MemoryEnd } from "../testing/memory-channel.js";
import { fakeClock } from "./helpers.js";

const approvalRef = z.strictObject({ challengeId: z.string().regex(/^[A-Za-z0-9_-]{22,64}$/) });
/** A tier 3 method (no native step): the protocol has none yet. */
const tier3: MethodSpec = {
  request: z.strictObject({ id: z.string().max(64), approval: approvalRef.optional() }),
  response: z.strictObject({ done: z.literal(true) }),
  sideEffect: "destructive",
  tier: 3,
  idempotency: "required",
  timeoutMs: 2000,
};
const registry: ContractRegistry = {
  lookup: (c, v, m) => (c === "axis.test" && v === 1 && m === "wipe" ? tier3 : protocolRegistry.lookup(c, v, m)),
  versions: (c) => (c === "axis.test" ? [1] : protocolRegistry.versions(c)),
};

export type Msg = { id?: string; ok?: boolean; type?: string; result?: Record<string, unknown>; error?: { code: string; message: string; details?: Record<string, unknown> } };

export class Client {
  readonly all: Msg[] = [];
  #waiters: Array<() => void> = [];
  #n = 0;
  constructor(readonly port: MessagePort) {
    port.on("message", (m: Msg) => {
      this.all.push(m);
      this.#waiters.splice(0).forEach((w) => w());
    });
  }
  async until(pred: (m: Msg) => boolean, ms = 2000): Promise<Msg> {
    const end = Date.now() + ms;
    for (;;) {
      const hit = this.all.find(pred);
      if (hit) return hit;
      if (Date.now() >= end) throw new Error(`timed out; got ${JSON.stringify(this.all).slice(0, 300)}`);
      await new Promise<void>((r) => {
        const t = setTimeout(r, 25);
        this.#waiters.push(() => (clearTimeout(t), r()));
      });
    }
  }
  /** Send a request and wait for its answer. */
  async call(contract: string, method: string, payload: unknown, key?: string): Promise<Msg> {
    const id = `q${++this.#n}`;
    this.send(contract, method, payload, id, key);
    return this.until((m) => m.id === id);
  }
  send(contract: string, method: string, payload: unknown, id: string, key?: string): void {
    this.port.postMessage({ v: 1, id, contract, contractVersion: 1, method, payload, ...(key ? { idempotencyKey: key } : {}) });
  }
  async hello(): Promise<void> {
    this.port.postMessage({
      type: "hello",
      protocolVersions: [1],
      contracts: [{ id: "axis.worktrees", versions: [1] }, { id: "axis.approvals", versions: [1] }, { id: "axis.cli-runs", versions: [1] }, { id: "axis.test", versions: [1] }],
    });
    await this.until((m) => m.type !== undefined);
  }
}

export interface RigOptions {
  limits?: ChallengeLimits;
  /** Replace the rule-table policy (to prove a handler's own checks). */
  policy?: Policy;
  failAudit?: (e: ChallengeAuditEvent) => boolean;
  controlMaxPending?: number;
  nativeWaitLimit?: number;
  nativeWaitPerWindow?: number;
  /** Where the challenge events go instead of the in-memory list (a real `AuditLog`). */
  audit?: { append(e: ChallengeAuditEvent): unknown };
}

/** The attestation is "<actor>#<connection>#<window>". */
const verifier: IdentityVerifier = {
  verify(att) {
    if (typeof att !== "string") return undefined;
    const [actor, conn, windowId] = att.split("#");
    return {
      connectionId: (conn as string).padEnd(22, "_"),
      windowId: windowId as string,
      actorId: `${actor}-id`,
      actor: actor as Identity["actor"],
      trusted: true,
      clientKind: "desktop",
    };
  },
};

export function newKey(): string {
  return randomUUID();
}

export async function rig(options: RigOptions = {}) {
  const clock = fakeClock();
  const challengeEvents: ChallengeAuditEvent[] = [];
  const rpcEvents: DaemonAuditEvent[] = [];
  const { a, b } = memoryChannelPair();
  const mux = new ChannelMux(a);
  const control = new ControlClient({ mux, ...(options.controlMaxPending ? { maxPending: options.controlMaxPending } : {}) });
  const supervisor: Array<Record<string, unknown>> = [];
  b.onMessage((m) => supervisor.push(m as Record<string, unknown>));
  const approvals: Approvals = createApprovals({
    audit: {
      append(e) {
        if (options.failAudit?.(e)) throw new Error("audit down");
        challengeEvents.push(e);
        options.audit?.append(e);
      },
    },
    control,
    clock,
    ...(options.limits ? { limits: options.limits } : {}),
    ...(options.nativeWaitLimit ? { nativeWaitLimit: options.nativeWaitLimit } : {}),
    ...(options.nativeWaitPerWindow ? { nativeWaitPerWindow: options.nativeWaitPerWindow } : {}),
  });
  const trust = new InMemoryTrustRegistry();
  const runs: Array<{ id: string; approved: unknown; payload: unknown }> = [];
  const gates: Array<() => Promise<void>> = [];
  const daemon = new Daemon({
    identity: verifier,
    audit: { append: (e) => void rpcEvents.push(e) },
    registry,
    idempotency: new MemoryIdempotencyStore(),
    policy: options.policy ?? new RuleTablePolicy(trust, { ...RULES, "axis.test/1.wipe": userRule(3) }),
    approvals: approvals.gate,
  });
  const run: Handler = async (c, p) => {
    runs.push({ id: (p as { id: string }).id, approved: { ...(c.approved ?? {}) }, payload: p });
    for (const g of gates.splice(0)) await g();
    return { id: (p as { id: string }).id, state: "CLEANED" };
  };
  daemon.register("axis.approvals", 1, createApprovalsHandlers({ approvals: approvals.port }));
  daemon.register("axis.worktrees", 1, { remove: run });
  daemon.register("axis.test", 1, { wipe: (async (c, p) => (await run(c, p), { done: true })) as Handler });
  const ports: MessagePort[] = [];
  const clients: Client[] = [];
  return {
    clock,
    approvals,
    control,
    challengeEvents,
    rpcEvents,
    supervisor,
    runs,
    /** The next handler call waits for `g` before it answers (to overlap two calls). */
    holdNextRun: (g: () => Promise<void>) => void gates.push(g),
    peer: b as MemoryEnd,
    daemon,
    async connect(attestation = "user#conn-1#win-1"): Promise<Client> {
      const { client, server } = memoryPair();
      ports.push(client);
      const c = new Client(client);
      clients.push(c);
      daemon.accept(server, attestation);
      await c.hello();
      return c;
    },
    /** What the supervisor received as `native.confirm`. */
    nativeConfirms: () => supervisor.filter((m) => m["type"] === "native.confirm"),
    answer(challengeId: string, proof: string, confirmed: boolean, windowId = "win-1"): void {
      b.send({ type: "native.result", challengeId, proof, confirmed, windowId });
    },
    async cleanup(): Promise<void> {
      approvals.dispose();
      control.dispose();
      mux.dispose();
      daemon.stop();
      for (const p of ports) p.close();
      b.close();
    },
  };
}
export type Rig = Awaited<ReturnType<typeof rig>>;

export const challengeOf = (m: Msg): Challenge => (m.error?.details as { challenge: Challenge }).challenge;
export const wipePayload = (over: Record<string, unknown> = {}) => ({ id: "ws-1", ...over });
export const removePayload = (over: Record<string, unknown> = {}) => ({ id: "ws-1", ...over });
