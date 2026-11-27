// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// TEST ONLY: the integrations options of the headless slice host (net-read-slice.md §7, §8), read from the JSON file
// `AXIS_SLICE_INTEGRATIONS` names: the egress client's test seam toward the test's loopback HTTPS server that answers as GitHub,
// and an in-memory secret backend holding the canary. Without the variable the host passes no `integrations` option, as the
// daemon entry does.
import { readFileSync } from "node:fs";
import { testBackend } from "./integrations-backend.js";
import type { ComposeOptions } from "../src/compose.js";
import { createEgressClientForTest } from "../src/net/egress-client.js";

export interface SliceIntegrationsConfig {
  /** The test server's certificate (PEM file), trusted as the only CA. */
  readonly caFile: string;
  /** The loopback port the client dials instead of 443. */
  readonly port: number;
  /** The token the backend holds for `integration:github`; absent: no entry. */
  readonly canary?: string;
  /** The entry's own metadata (default: the memory backend's, which the reveal gate accepts). */
  readonly entryMeta?: { readonly backend: "macos_keychain" | "basic_text"; readonly protection: "os_protected" | "none" };
  /** No backend at all, only the client (net-read-slice.md §7's second run). */
  readonly noBackend?: boolean;
}

/** A public address the seam's resolver answers, so the address rule runs; the dial maps it to the loopback server. */
const PUBLIC = "93.184.215.14";

export function sliceIntegrations(env: NodeJS.ProcessEnv): ComposeOptions["integrations"] | undefined {
  const file = env["AXIS_SLICE_INTEGRATIONS"];
  if (file === undefined) return undefined;
  const config = JSON.parse(readFileSync(file, "utf8")) as SliceIntegrationsConfig;
  const client = createEgressClientForTest({}, { ca: readFileSync(config.caFile), resolve: async () => [PUBLIC], dial: (a) => (a === PUBLIC ? "127.0.0.1" : a), port: config.port });
  if (config.noBackend === true) return { client };
  const backend = testBackend();
  if (config.canary !== undefined) backend.seed("integration:github", config.canary, config.entryMeta ?? {});
  return { client, vaultBackend: backend };
}
