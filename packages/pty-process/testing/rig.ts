// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { createPtyProcessPort, createPtyService, type PtyProcessPort, type PtyService, type SpawnFn, type SpawnRequest } from "../src/index.js";
import { channelPair, counterRandom, FakeChild, FakeProcs, ManualClock, type ChannelPair } from "./helpers.js";

export const SPEC = { runId: "run1", argv: ["/bin/true"], cwd: "/work", env: { PATH: "/usr/bin", SSH_AUTH_SOCK: "/run/agent" }, cols: 80, rows: 24 } as const;

/** TEST ONLY: the host port, the pty service and fake children wired over an in-memory control channel. */
export function rig(opts: { spawn?: SpawnFn; maxTerminals?: number; spawnTimeoutMs?: number; maxPending?: number } = {}): {
  port: PtyProcessPort;
  service: PtyService;
  pair: ChannelPair;
  clock: ManualClock;
  procs: FakeProcs;
  children: FakeChild[];
  requests: SpawnRequest[];
} {
  const pair = channelPair();
  const clock = new ManualClock();
  const procs = new FakeProcs();
  const children: FakeChild[] = [];
  const requests: SpawnRequest[] = [];
  let pid = 100;
  const spawn: SpawnFn =
    opts.spawn ??
    (() => {
      const c = new FakeChild(++pid);
      procs.live.add(c.pid);
      children.push(c);
      return c;
    });
  const service = createPtyService({ spawn: (req) => (requests.push(req), spawn(req)), ops: procs, randomBytes: counterRandom(), ...(opts.maxTerminals === undefined ? {} : { maxTerminals: opts.maxTerminals }) });
  service.serveControl(pair.b);
  const port = createPtyProcessPort({ channel: pair.a, ops: procs, clock, ...(opts.spawnTimeoutMs === undefined ? {} : { spawnTimeoutMs: opts.spawnTimeoutMs }), ...(opts.maxPending === undefined ? {} : { maxPending: opts.maxPending }) });
  return { port, service, pair, clock, procs, children, requests };
}
