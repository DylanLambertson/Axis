// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Runs the shared provider contract suite against the Anthropic adapter, with
// a fake transport that echoes a canary and the credential into error bodies,
// headers and the stream (ANT-1). No network: every request goes through the
// suite's transport, and the fake server makes none.
import { runProviderContractSuite } from "@axis/providers/contract";
import { createAnthropicAdapter } from "../src/index.js";
import { MODEL, scenarioFetch } from "./support/scenarios.js";

const CANARY = "canary-qz-body-text-77";
// Low-entropy stand-in for an API credential.
const CREDENTIAL = "holdout-zq7x-standin-0042";

runProviderContractSuite({
  name: "anthropic",
  canary: CANARY,
  credential: CREDENTIAL,
  setup(scenario, transport) {
    const fake = scenarioFetch(scenario, CANARY, CREDENTIAL);
    const adapter = createAnthropicAdapter({
      connectionId: "anthropic-contract",
      apiKey: () => CREDENTIAL,
      // The suite records every request at this seam and plays the redirect scenario itself.
      fetch: transport.wrap(fake.fetch),
      pricing: (m) => (m === MODEL ? { inputMicroUsdPerMTok: 3_000_000, outputMicroUsdPerMTok: 15_000_000 } : undefined),
    });
    return { adapter, model: MODEL, requestCount: () => fake.messageRequests(), openStreams: () => fake.counter.open, lastRequest: () => fake.lastRequest() };
  },
});
