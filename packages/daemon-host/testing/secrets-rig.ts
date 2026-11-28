// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// TEST ONLY (PV-N0c-1): the daemon's secret backend over a real ControlClient and ChannelMux, with the fake main
// (`secrets-main.ts`) on the other end of an in-memory channel.
import { ChannelMux } from "../src/transport/mux.js";
import { ControlClient } from "../src/control/client.js";
import { createBrokerSecretBackend, type BrokerEvent } from "../src/secrets-backend.js";
import { memoryChannelPair } from "./memory-channel.js";
import { FakeSecretsMain, type FakeSecretsMainOptions } from "./secrets-main.js";

export const SECRET = "test-credential-value-0001";
export const META = Object.freeze({ storedAt: 5, backend: "gnome_libsecret", protection: "os_protected", weakConsent: false } as const);
/** Main answers `put` at 100 ms and the rest at 400 ms; the daemon waits 600 ms (main answers or gives up first, §3.4). */
export const MAIN: FakeSecretsMainOptions = Object.freeze({ budgetMs: { put: 100, get: 400, meta: 400, remove: 400, list: 400 } });

export function secretsRig(options: FakeSecretsMainOptions = MAIN, daemonMs = 600) {
  const { a, b } = memoryChannelPair();
  const client = new ControlClient({ mux: new ChannelMux(a) });
  const main = new FakeSecretsMain(options);
  b.onMessage((m) => {
    const msg = m as { type: string; requestId: string };
    if (FakeSecretsMain.handles(msg)) main.handle(msg, (answer) => b.send(answer));
  });
  const events: BrokerEvent[] = [];
  const backend = createBrokerSecretBackend({ client, onEvent: (e) => void events.push(e), timeoutsMs: { slow: daemonMs, fast: daemonMs } });
  /** What main received, as `op:name`. */
  const ops = (): string[] => main.seen.map((m) => `${m.type.slice(8)}${typeof m["name"] === "string" ? `:${m["name"] as string}` : ""}`);
  return { a, b, client, main, backend, events, ops };
}
