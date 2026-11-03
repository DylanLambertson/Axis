// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Runs the shared provider contract suite against the Anthropic adapter, with
// a fake transport that echoes a canary and the credential into error bodies,
// headers and the stream (ANT-1). No network.
import { runProviderContractSuite } from "@axis/providers/contract";
import { createAnthropicAdapter } from "../src/index.js";
import { MODEL, scenarioFetch } from "./support/scenarios.js";

const CANARY = "contract-canary-body-text";
// Low-entropy stand-in for an API credential.
const CREDENTIAL = "contract-credential-stand-in";

runProviderContractSuite({
  name: "anthropic",
  canary: CANARY,
  credential: CREDENTIAL,
  setup(scenario) {
    const fake = scenarioFetch(scenario, CANARY, CREDENTIAL);
    const adapter = createAnthropicAdapter({
      connectionId: "anthropic-contract",
      apiKey: () => CREDENTIAL,
      fetch: fake.fetch,
      pricing: (m) => (m === MODEL ? { inputMicroUsdPerMTok: 3_000_000, outputMicroUsdPerMTok: 15_000_000 } : undefined),
    });
    return { adapter, model: MODEL, requestCount: () => fake.messageRequests(), openStreams: () => fake.counter.open };
  },
});
