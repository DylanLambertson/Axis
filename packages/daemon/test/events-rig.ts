// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { TestContext } from "node:test";
import { EVENTS_CONTRACT, serverFrameSchema } from "@axis/protocol";
import { EventHub, protocolRegistry, type ContractRegistry, type DaemonOptions, type EventHubOptions, type Handler } from "../src/index.js";
import { CONTRACT, Inbox, rig, testRegistry, type Rig } from "./harness.js";

/** The protocol registry (with `axis.events/1`) plus the test contract. */
const registry: ContractRegistry = {
  lookup: (c, v, m) => (c === CONTRACT ? testRegistry.lookup(c, v, m) : protocolRegistry.lookup(c, v, m)),
  versions: (c) => (c === CONTRACT ? testRegistry.versions(c) : protocolRegistry.versions(c)),
};

export type Frame = { v: number; sub: string; seq?: number; event?: Record<string, unknown>; resync?: { reason: string }; end?: { reason: string } };
export type Reply = { id: string; ok: boolean; result?: Record<string, unknown>; error?: { code: string } };

export const isFrame = (m: unknown): m is Frame => typeof m === "object" && m !== null && "sub" in m;
export const framesOf = (inbox: Inbox, sub?: string): Frame[] => inbox.all.filter(isFrame).filter((f) => sub === undefined || f.sub === sub);

export const ehello = { type: "hello", protocolVersions: [1], contracts: [{ id: EVENTS_CONTRACT, versions: [1] }, { id: CONTRACT, versions: [1] }] };
export const ereq = (id: string, method: "subscribe" | "unsubscribe", payload: unknown, over: Record<string, unknown> = {}) => ({
  v: 1,
  id,
  contract: EVENTS_CONTRACT,
  contractVersion: 1,
  method,
  payload,
  ...over,
});

export interface EventsRig extends Rig {
  hub: EventHub;
  /** Connect and complete the handshake; returns the client side. */
  open(attestation: string): Promise<{ send(m: unknown): void; inbox: Inbox }>;
  subscribe(c: { send(m: unknown): void; inbox: Inbox }, id: string, payload: unknown): Promise<Reply>;
}

type Handlers = { readonly subscribe: Handler; readonly unsubscribe: Handler };

export async function eventsRig(
  t: TestContext,
  hubOptions: EventHubOptions = {},
  options: Partial<DaemonOptions> = {},
  hub?: EventHub,
  wrap: (h: Handlers) => Handlers = (h) => h,
): Promise<EventsRig> {
  const h = hub ?? new EventHub(hubOptions);
  const r = rig({ registry, events: h, ...options });
  r.daemon.register(EVENTS_CONTRACT, 1, wrap(h.handlers()));
  t.after(() => r.cleanup());
  r.send(ehello);
  await r.inbox.until((m): m is { type: "welcome" } => (m as { type?: string }).type === "welcome");
  const open = async (att: string) => {
    const c = r.connect(att);
    c.client.postMessage(ehello);
    await c.inbox.until((m): m is { type: "welcome" } => (m as { type?: string }).type === "welcome");
    return { send: (m: unknown) => c.client.postMessage(m), inbox: c.inbox };
  };
  const subscribe = async (c: { send(m: unknown): void; inbox: Inbox }, id: string, payload: unknown) => {
    c.send(ereq(id, "subscribe", payload));
    return (await c.inbox.response(id)) as Reply;
  };
  return Object.assign(r, { hub: h, open, subscribe });
}

/** Wait until `n` frames of `sub` arrived (bounded by the inbox's own deadline). */
export async function frames(inbox: Inbox, sub: string, n: number): Promise<Frame[]> {
  await inbox.until((_m): _m is unknown => framesOf(inbox, sub).length >= n);
  return framesOf(inbox, sub);
}

/** A round trip on the same port: everything the daemon sent before the answer to `id` has arrived. */
export async function settle(c: { send(m: unknown): void; inbox: Inbox }, id: string): Promise<void> {
  c.send(ereq(id, "unsubscribe", { subscriptionId: "A".repeat(22) }));
  await c.inbox.response(id);
}

/** Every frame on the wire is a valid, closed frame. */
export function assertWireFrames(inbox: Inbox): void {
  for (const f of inbox.all.filter(isFrame)) {
    if (!serverFrameSchema.safeParse(f).success) throw new Error(`invalid frame on the wire: ${JSON.stringify(f)}`);
  }
}

/** Poll a condition the test cannot be told about (a port closing on the far side); bounded, never a timing assertion. */
export async function eventually(cond: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((r) => setTimeout(r, 5));
  }
}
