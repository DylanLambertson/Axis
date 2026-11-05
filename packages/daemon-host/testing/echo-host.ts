// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// A minimal host for the control channel tests only: it is not the daemon host (that is ticket H2). It speaks the
// real ChannelMux, ControlClient, attestation verifier and connect limiter, so the supervisor fixture and the
// transports are tested end to end. Run as a child process (IPC) or as a worker thread (message port).
import { isMainThread, parentPort } from "node:worker_threads";
import { Redactor } from "@axis/audit";
import type { Connection, Identity } from "@axis/daemon";
import {
  ChannelMux,
  ControlClient,
  Disposables,
  adaptNodeIpc,
  adaptNodePort,
  createAttestationVerifier,
  createConnectLimiter,
  createConnectRouter,
  parseHostConfig,
  type Clock,
  type DisposableChannel,
} from "../src/index.js";

const clock: Clock = { now: () => Date.now(), monotonic: () => performance.now() };
const disposables = new Disposables();
const channel: DisposableChannel = !isMainThread && parentPort !== null ? adaptNodePort(parentPort) : adaptNodeIpc(process);
const mux = new ChannelMux(channel);
const client = new ControlClient({ mux });
disposables.add(() => channel.dispose(), "channel");
disposables.add(() => mux.dispose(), "mux");
disposables.add(() => client.dispose(), "client");
const acks: number[] = [];
client.onAnchorAck((seq) => acks.push(seq));

type Op = { op: string; [k: string]: unknown };

async function run(identity: Identity, m: Op): Promise<Record<string, unknown>> {
  switch (m.op) {
    case "echo":
      return { echo: m["v"], actor: identity.actor, windowId: identity.windowId };
    case "trust":
      await client.trustCheck({ windowId: identity.windowId, workspaceId: "ws-1", projectId: "p-1" });
      return { trusted: true };
    case "native":
      return { ...(await client.nativeConfirm({ challengeId: m["challengeId"] as string, proof: m["proof"] as string, windowId: identity.windowId, summary: "Test action" })) };
    case "anchor-get":
      return { anchor: await client.anchorGet() };
    case "anchor-put":
      client.anchorPut({ seq: m["seq"] as number, hash: m["hash"] as string });
      return { sent: true };
    case "acks":
      return { acks: [...acks] };
    case "settings":
      return { value: await client.settingsGet(m["key"] as "axis.cliAgents") };
    default:
      return { unknown: true };
  }
}

client.onInit((raw) => {
  const config = parseHostConfig(raw, new Redactor());
  const verifier = createAttestationVerifier({ key: config.attestationKey, clock });
  disposables.add(() => verifier.close(), "verifier");
  const limiter = createConnectLimiter({
    clock,
    ...(config.limits.connectsPerMinute === undefined ? {} : { connectsPerMinute: config.limits.connectsPerMinute }),
    ...(config.limits.connectBurst === undefined ? {} : { burst: config.limits.connectBurst }),
  });
  const router = createConnectRouter({
    mux,
    limiter,
    accept: (conn: Connection, attestation) => {
      const identity = verifier.verify(attestation);
      if (identity === undefined) return conn.close();
      conn.onMessage((raw2) => {
        run(identity, raw2 as Op).then(
          (reply) => conn.send({ ok: true, ...reply }),
          (e: { code?: string }) => conn.send({ ok: false, code: e.code ?? "E_INTERNAL" }),
        );
      });
    },
  });
  client.onConnect((c) => router.fromMux(c));
  client.send({ type: "ready", protocolVersion: 1, contracts: [] });
});

client.onShutdown(() => void disposables.dispose());
