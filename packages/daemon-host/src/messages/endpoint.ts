// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { createHash, timingSafeEqual } from "node:crypto";
import { MAX_BODY_CHARS, MAX_READ_MESSAGES, messageIdSchema, recipientsSchema, threadIdSchema } from "@axis/protocol";
import { z } from "zod";
import { MESSAGE_AUDIT, type MessageAuditSink } from "./audit.js";
import { WITHHELD_BODY, senderLabel } from "./delivery.js";
import { MINUTE_MS, WindowCounter } from "./limits.js";
import { MessageRefusal, senderEntry, senderPaused, type MessageCaller, type MessagingDirectory } from "./policy.js";
import type { MessageService } from "./service.js";
import { InvalidMessageRequest } from "./wire.js";

/**
 * The daemon's side of the CLI messaging endpoint (ticket PV-M6 slice 1; ADR 0007 decision 7; docs/design/
 * inter-agent-cli-endpoint.md). The pty process hosts the listener and relays each complete frame on its supervised control
 * channel; everything that decides is here:
 *
 * - **Minted by the daemon, inert until PV-G4.** `mint(runId)` gives a run its endpoint id (derived from the run id) and a token of
 *   256 random bits, only for a live run whose CLI agent the directory knows and whose messaging the user enabled, never on
 *   Windows (no native pipe helper, ADR 0007 validation line 3). No run records its agent yet, so nothing is minted in production.
 * - **The relay is untrusted.** A message counts only from the supervised channel (`source`); a frame for an endpoint id the
 *   daemon did not mint, a revoked one, a run that is not RUNNING, a connection that was not opened, was closed or failed its
 *   auth, a second `auth`, or a fifth relay in flight is refused. Frames are JSON of at most 64 KiB and depth 32, strict schemas.
 * - **The token.** Compared in constant time (SHA-256 of both sides); never logged, audited or journaled. Failures are audited as
 *   one aggregated `message.endpoint` row per endpoint and minute.
 * - **The caller** is the binding's, never the frame's: `{ agent, agentId, runId, verified: false }` with the run's received hop,
 *   which every read raises to the highest hop it returns and nothing lowers.
 * - **Answers** go through the message service and are escaped there (`toMessageText`); a body whose raw or escaped text holds a
 *   registered secret is withheld (`readWithheld`, section 11 of messages-contract.md).
 */

export const ENDPOINT_LIMITS = Object.freeze({ inflight: 4, connections: 4, readsPerMinute: 60, maxEndpoints: 256, frameChars: 64 * 1024, depth: 32, replyBytes: 1024 * 1024 });

/**
 * A reply frame's JSON text, at most `maxBytes` UTF-8 BYTES on the wire (review s2 S2: counted in bytes, not UTF-16 units,
 * which could be three times as many bytes); a larger body becomes the closed `too_large`, keeping its request id.
 */
export function replyFrame(body: Record<string, unknown>, maxBytes: number = ENDPOINT_LIMITS.replyBytes): string {
  const frame = JSON.stringify(body);
  return Buffer.byteLength(frame, "utf8") <= maxBytes ? frame : JSON.stringify({ ...(typeof body["id"] === "string" ? { id: body["id"] } : {}), ok: false, reason: "too_large" });
}

/** A relayed message, as the pty binding parsed it with the shared envelope schema (`@axis/pty-process/client` `relayInbound`). */
export type RelayIn =
  | { readonly t: "relay-open"; readonly endpoint: string; readonly conn: string }
  | { readonly t: "relay-frame"; readonly endpoint: string; readonly conn: string; readonly frame: string }
  | { readonly t: "relay-close"; readonly endpoint: string; readonly conn: string };
export type RelayOut =
  | { readonly t: "relay-reply"; readonly endpoint: string; readonly conn: string; readonly frame: string; readonly close: boolean; readonly authFailed: boolean }
  | { readonly t: "endpoint-close"; readonly endpoint: string; readonly reason: "revoked" }
  /** Pause (slice 3): every connection of the endpoint closes, the listener stays, so a resume needs no new endpoint. */
  | { readonly t: "endpoint-drop"; readonly endpoint: string; readonly reason: "paused" };

const ENDPOINT_ID = /^ep_[A-Za-z0-9_-]{22,64}$/;
const CONN_ID = /^[a-z0-9_-]{1,64}$/;
const reqId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
export const endpointFrame = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("auth"), token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }),
  z.strictObject({ op: z.literal("send"), id: reqId, recipients: recipientsSchema, body: z.string().min(1).max(MAX_BODY_CHARS), threadId: threadIdSchema.optional(), inReplyTo: messageIdSchema.optional() }),
  z.strictObject({ op: z.literal("read"), id: reqId, threadId: threadIdSchema.optional(), afterSeq: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(MAX_READ_MESSAGES).optional() }),
]);

export interface EndpointRelayDeps {
  readonly service: Pick<MessageService, "send" | "readWithheld" | "context">;
  readonly directory: MessagingDirectory;
  /** The agent a run acts for (PV-G4 records it); none today. */
  readonly agentOf: (runId: string) => string | undefined;
  /** True while the run is RUNNING. */
  readonly runLive: (runId: string) => boolean;
  /**
   * True while the supervisor is launching the run (QUEUED: spawned but not yet RUNNING). The endpoint is minted in the spawn,
   * before the run is RUNNING, so mint accepts this state; a message before RUNNING answers `not_ready` and revokes nothing.
   */
  readonly runLaunching?: (runId: string) => boolean;
  readonly random: { bytes(n: number): Uint8Array };
  readonly audit: MessageAuditSink;
  /** Called after each audit row (the anchor guard's `noteWrite`). */
  readonly noteWrite?: () => void;
  readonly now: () => number;
  readonly monotonic: () => number;
  /** The host redactor's check (a secret) for the raw and escaped text of each body a read returns. */
  readonly holdsSecret: (text: string) => boolean;
  readonly platform: NodeJS.Platform;
  /** The mark of the supervised pty control channel: a relay message from anything else is refused. */
  readonly source: symbol;
}

export interface EndpointRelay {
  /** The endpoint of a run that may have one, or undefined (inert until PV-G4). One per run. */
  mint(runId: string): { readonly endpointId: string; readonly token: string } | undefined;
  /** Revoke a run's endpoint (it left RUNNING, its messaging was disabled): every connection closes, later frames answer `revoked`. */
  revoke(runId: string): RelayOut | undefined;
  /** A worker's messaging was turned off (slice 3): every live endpoint of that worker is revoked. */
  revokeWorker(agentId: string): RelayOut[];
  /** A pause changed in a project (slice 3): each live endpoint whose sender is now paused drops its connections. */
  dropPaused(projectId: string): RelayOut[];
  /** One relayed message; the messages to send back on the control channel. */
  onRelay(source: symbol, msg: RelayIn): Promise<readonly RelayOut[]>;
  /** Write the aggregated failure rows still pending (shutdown). */
  flush(): void;
}

interface Endpoint {
  readonly id: string;
  readonly runId: string;
  readonly agentId: string;
  readonly projectId: string;
  token: Buffer | undefined;
  revoked: boolean;
  receivedHop: number;
  inflight: number;
  readonly conns: Map<string, "open" | "authed" | "failed">;
  failures: { start: number; count: number; firstAt: number; lastAt: number } | undefined;
}

const digest = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();
const b64url = (b: Uint8Array): string => Buffer.from(b).toString("base64url");
/**
 * The endpoint id of a run: derived from its id, so the daemon maps an endpoint to its run without a lookup the relay names. It
 * is NOT a secret (anyone who knows the run id can compute it; review s1 N1): the 256-bit token is the only secret, and the pty
 * process relays only for the endpoints it hosts.
 */
export const endpointIdOf = (runId: string): string => `ep_${b64url(createHash("sha256").update(`axis-endpoint\0${runId}`, "utf8").digest())}`;

/** Depth of a parsed JSON value, iteratively, stopping past `max`. */
function depthWithin(value: unknown, max: number): boolean {
  const stack: [unknown, number][] = [[value, 1]];
  while (stack.length > 0) {
    const [v, d] = stack.pop() as [unknown, number];
    if (typeof v !== "object" || v === null) continue;
    if (d > max) return false;
    for (const child of Object.values(v)) stack.push([child, d + 1]);
  }
  return true;
}

export function createEndpointRelay(deps: EndpointRelayDeps): EndpointRelay {
  // Live endpoints only: a revoked one is removed (review s1 SF), so the table never holds more than `maxEndpoints` live ones,
  // whatever the daemon's lifetime. What stays of a revoked endpoint is a tombstone (its id and run) in a ring of the last
  // `maxEndpoints` revocations, so a late frame answers `revoked` and the run is not minted again; past the ring, `refused`.
  const byId = new Map<string, Endpoint>();
  const byRun = new Map<string, Endpoint>();
  const tombstones = new Map<string, string>();
  const tombstoneRuns = new Set<string>();
  const launching = (runId: string): boolean => deps.runLaunching?.(runId) === true;
  const reads = new WindowCounter(ENDPOINT_LIMITS.readsPerMinute, MINUTE_MS, ENDPOINT_LIMITS.maxEndpoints, deps.monotonic);

  const audit = (ep: Endpoint, event: string, extra: Record<string, string | number> = {}): void => {
    deps.audit.append({ actor: "daemon", action: MESSAGE_AUDIT.endpoint, target: `run:${ep.runId}`, outcome: event === "auth_failed" ? "denied" : "success", payload: { endpointId: ep.id, runId: ep.runId, agentId: ep.agentId, event, ...extra } });
    deps.noteWrite?.();
  };
  /** One aggregated row per endpoint and minute of token failures (count, first and last time). */
  const flushFailures = (ep: Endpoint): void => {
    const f = ep.failures;
    if (f === undefined || f.count === 0) return;
    ep.failures = undefined;
    audit(ep, "auth_failed", { failures: f.count, firstAt: f.firstAt, lastAt: f.lastAt });
  };
  const noteFailure = (ep: Endpoint): void => {
    const t = deps.monotonic();
    if (ep.failures !== undefined && t - ep.failures.start >= MINUTE_MS) flushFailures(ep);
    const at = deps.now();
    ep.failures ??= { start: t, count: 0, firstAt: at, lastAt: at };
    ep.failures.count += 1;
    ep.failures.lastAt = at;
  };

  const reply = (endpoint: string, conn: string, body: Record<string, unknown>, close = false, authFailed = false): RelayOut => {
    return { t: "relay-reply", endpoint, conn, frame: replyFrame(body), close, authFailed };
  };
  const refuse = (endpoint: string, conn: string, reason: string, close = true): RelayOut[] => [reply(endpoint, conn, { ok: false, reason }, close)];

  function revokeEndpoint(ep: Endpoint): RelayOut {
    if (!ep.revoked) {
      ep.revoked = true;
      ep.token?.fill(0); // wiped, not only dropped: a request still in flight holds this object
      ep.token = undefined;
      ep.conns.clear();
      flushFailures(ep);
      audit(ep, "revoked");
      byId.delete(ep.id);
      byRun.delete(ep.runId);
      tombstones.set(ep.id, ep.runId);
      tombstoneRuns.add(ep.runId);
      if (tombstones.size > ENDPOINT_LIMITS.maxEndpoints) {
        const [oldId, oldRun] = tombstones.entries().next().value as [string, string];
        tombstones.delete(oldId);
        tombstoneRuns.delete(oldRun);
      }
    }
    return { t: "endpoint-close", endpoint: ep.id, reason: "revoked" };
  }

  /** The worker's endpoint setting as stored now: off (or the worker gone) means the endpoint must not serve (slice 3 backstop). */
  function enabled(ep: Endpoint): boolean {
    const entry = deps.directory.agent(ep.agentId);
    return entry !== undefined && entry.projectId === ep.projectId && deps.service.context(ep.projectId).agentSettings(entry).cliMessaging;
  }

  function caller(ep: Endpoint): Extract<MessageCaller, { kind: "agent" }> {
    return { kind: "agent", agentId: ep.agentId, runId: ep.runId, verified: false, receivedHop: ep.receivedHop };
  }

  async function serve(ep: Endpoint, conn: string, f: Exclude<z.infer<typeof endpointFrame>, { op: "auth" }>): Promise<RelayOut[]> {
    const who = caller(ep);
    try {
      const ctx = deps.service.context(ep.projectId);
      if (senderPaused(who, senderEntry(who, ctx), ctx.settings)) return refuse(ep.id, conn, "paused");
      if (f.op === "read") {
        if (!reads.take(ep.id)) return [reply(ep.id, conn, { id: f.id, ok: false, reason: "rate_limited" })];
        const req = { ...(f.threadId === undefined ? {} : { threadId: f.threadId }), ...(f.afterSeq === undefined ? {} : { afterSeq: f.afterSeq }), ...(f.limit === undefined ? {} : { limit: f.limit }) };
        const out = deps.service.readWithheld(who, req, deps.holdsSecret);
        // ADR 0007 decision 5: the CLI run's received hop is the highest it has read, per run, never lowered.
        for (const m of out.messages) ep.receivedHop = Math.max(ep.receivedHop, m.hop);
        const messages = out.messages.map((m) => {
          const s = senderLabel(m.sender, deps.directory);
          return { messageId: m.messageId, threadId: m.threadId, seq: m.seq, hop: m.hop, inReplyTo: m.inReplyTo, sender: { name: s.name, kind: s.kind, verified: s.verified }, body: out.withheld.has(m.messageId) ? WITHHELD_BODY : m.body.text };
        });
        return [reply(ep.id, conn, { id: f.id, ok: true, messages, more: out.more })];
      }
      const req = { recipients: f.recipients, body: { format: "text" as const, text: f.body }, ...(f.threadId === undefined ? {} : { threadId: f.threadId }), ...(f.inReplyTo === undefined ? {} : { inReplyTo: f.inReplyTo }) };
      const { message } = await deps.service.send(who, req);
      return [reply(ep.id, conn, { id: f.id, ok: true, messageId: message.messageId, threadId: message.threadId, seq: message.seq, hop: message.hop })];
    } catch (e) {
      // Only a closed reason leaves: a refusal's own, `invalid`, or `failed` for anything else (never an error's text).
      const reason = e instanceof MessageRefusal ? e.reason : e instanceof InvalidMessageRequest ? "invalid" : "failed";
      return [reply(ep.id, conn, { id: f.id, ok: false, reason })];
    }
  }

  return {
    mint(runId) {
      if (deps.platform === "win32" || byRun.has(runId) || tombstoneRuns.has(runId) || byRun.size >= ENDPOINT_LIMITS.maxEndpoints || !(deps.runLive(runId) || launching(runId))) return undefined;
      const agentId = deps.agentOf(runId);
      const entry = agentId === undefined ? undefined : deps.directory.agent(agentId);
      if (agentId === undefined || entry === undefined || entry.kind !== "cli") return undefined;
      if (!deps.service.context(entry.projectId).agentSettings(entry).cliMessaging) return undefined;
      const token = b64url(deps.random.bytes(32));
      const ep: Endpoint = { id: endpointIdOf(runId), runId, agentId, projectId: entry.projectId, token: digest(token), revoked: false, receivedHop: 0, inflight: 0, conns: new Map(), failures: undefined };
      byId.set(ep.id, ep);
      byRun.set(runId, ep);
      audit(ep, "minted");
      return { endpointId: ep.id, token };
    },

    revoke(runId) {
      const ep = byRun.get(runId);
      if (ep !== undefined) return revokeEndpoint(ep);
      return tombstoneRuns.has(runId) ? { t: "endpoint-close", endpoint: endpointIdOf(runId), reason: "revoked" } : undefined;
    },

    revokeWorker(agentId) {
      return [...byId.values()].filter((ep) => ep.agentId === agentId).map(revokeEndpoint);
    },

    dropPaused(projectId) {
      const out: RelayOut[] = [];
      for (const ep of byId.values()) {
        if (ep.projectId !== projectId || ep.conns.size === 0) continue;
        const ctx = deps.service.context(projectId);
        const who = caller(ep);
        if (!senderPaused(who, deps.directory.agent(ep.agentId), ctx.settings)) continue;
        audit(ep, "paused", { connections: ep.conns.size });
        ep.conns.clear(); // the pty process closes them; a late reply to one finds no connection there
        out.push({ t: "endpoint-drop", endpoint: ep.id, reason: "paused" });
      }
      return out;
    },

    flush: () => byId.forEach(flushFailures),

    async onRelay(source, msg) {
      const { endpoint, conn } = msg;
      // ADR 0007 validation line 7: only the supervised channel, only ids of the shapes the envelope allows, only minted ids.
      if (source !== deps.source || typeof endpoint !== "string" || typeof conn !== "string" || !ENDPOINT_ID.test(endpoint) || !CONN_ID.test(conn)) return [];
      const ep = byId.get(endpoint);
      if (ep === undefined) {
        if (!tombstones.has(endpoint)) return msg.t === "relay-close" ? [] : refuse(endpoint, conn, "refused");
        // Revoked earlier: close the endpoint again (idempotent), so a pty process that never got the first close stops listening.
        const close: RelayOut = { t: "endpoint-close", endpoint, reason: "revoked" };
        return msg.t === "relay-close" ? [close] : [close, ...refuse(endpoint, conn, "revoked")];
      }
      // The messaging setting is checked BEFORE the launch window: an endpoint whose worker's messaging is off is revoked even while QUEUED.
      if (!enabled(ep)) return msg.t === "relay-close" ? [revokeEndpoint(ep)] : [revokeEndpoint(ep), ...refuse(endpoint, conn, "revoked")];
      if (!deps.runLive(ep.runId)) {
        // Still being launched (QUEUED): nothing is relayed as the worker before RUNNING, and the endpoint stays. Any other
        // state (terminal, or REVIEWING and BLOCKED as before) revokes.
        if (launching(ep.runId)) return msg.t === "relay-close" ? [] : refuse(endpoint, conn, "not_ready");
        return msg.t === "relay-close" ? [revokeEndpoint(ep)] : [revokeEndpoint(ep), ...refuse(endpoint, conn, "revoked")];
      }
      if (msg.t === "relay-close") {
        ep.conns.delete(conn);
        return [];
      }
      if (msg.t === "relay-open") {
        if (ep.conns.has(conn) || ep.conns.size >= ENDPOINT_LIMITS.connections) return refuse(endpoint, conn, "refused");
        ep.conns.set(conn, "open");
        return [];
      }
      const state = ep.conns.get(conn);
      if (state === undefined || state === "failed") return refuse(endpoint, conn, "refused");
      let f: z.infer<typeof endpointFrame>;
      try {
        if (msg.frame.length > ENDPOINT_LIMITS.frameChars) throw new Error("too large");
        const value: unknown = JSON.parse(msg.frame);
        if (!depthWithin(value, ENDPOINT_LIMITS.depth)) throw new Error("too deep");
        f = endpointFrame.parse(value);
      } catch {
        ep.conns.delete(conn);
        return refuse(endpoint, conn, "invalid");
      }
      if (state === "open") {
        // The first frame must be `auth`; one attempt per connection, compared in constant time.
        if (f.op !== "auth") {
          ep.conns.delete(conn);
          return refuse(endpoint, conn, "unauthenticated");
        }
        const ok = ep.token !== undefined && timingSafeEqual(digest(f.token), ep.token);
        if (!ok) {
          ep.conns.set(conn, "failed");
          noteFailure(ep);
          return [reply(endpoint, conn, { ok: false, reason: "bad_token" }, true, true)];
        }
        ep.conns.set(conn, "authed");
        return [reply(endpoint, conn, { ok: true, op: "auth" })];
      }
      if (f.op === "auth") {
        ep.conns.delete(conn);
        return refuse(endpoint, conn, "refused");
      }
      if (ep.inflight >= ENDPOINT_LIMITS.inflight) return [reply(endpoint, conn, { id: f.id, ok: false, reason: "busy" })];
      ep.inflight += 1;
      try {
        return await serve(ep, conn, f);
      } finally {
        ep.inflight -= 1;
      }
    },
  };
}
