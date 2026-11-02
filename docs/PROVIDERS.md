# AI Provider Integration Strategy

## Principle
Providers are capabilities behind adapters, not separate application silos. Connection methods must be documented and authorized. Consumer product subscriptions do not imply API entitlement or transferable access to proprietary app features.

## Connection types
1. Official OAuth or other published account connection flow when the provider exposes it for this use case.
2. Provider-issued API keys, scoped project keys, and organization credentials.
3. Supported local CLI sessions, only via documented CLI interfaces and terms; never read private session stores or repurpose credentials.
4. Custom OpenAI-compatible or explicitly specified HTTP APIs, local inference endpoints, and enterprise gateways with user-supplied config.

**CLI coding agents (Phase 1a).** Separately from provider connections, Axis launches the user's installed agent CLIs in a workspace terminal through their documented command-line interfaces, under the user's own login and terms. Axis tracks them only through process and terminal state it owns; it never reads their private session stores, extracts tokens or impersonates their clients, and injects no Axis-held credentials into their environment (PTY-5, ADR 0004).

## Candidate providers
In order: Anthropic/Claude API first (Phase 1b, API key in the connection vault; ADR 0004), then OpenAI, Google/Gemini, and other providers via verified public APIs; local model servers via documented protocols. Each adapter records supported authentication, tools, image input, streaming, structured output, reasoning controls, caching, rate limits, context size, costs and data retention terms where available. Do not hardcode assumptions about model names or availability.

## Capability registry
Capabilities are per *connection + model + API version*, not only per provider. UI must show unsupported/unknown features explicitly. Examples: tool calls, JSON schema, multimodal, file attachments, long context, web search, computer use, batch, artifact generation, provider-managed memory. Use capability negotiation and feature flags.

## Provider-specific artifacts
Claude Projects, consumer-app documents/slides and analogous features may lack public programmatic APIs. Do not claim to sync or reproduce them exactly. Offer native project collections, documents, slides and structured artifacts with provider-agnostic storage; integrate proprietary features only through officially supported paths. Track integration feasibility in a matrix with VERIFIED, EXPERIMENTAL, UNSUPPORTED states.

## Routing
Manual model selection and role defaults; optional automatic routing by task, cost, latency, privacy, context and capabilities. Explicit fallback policy, clear cost visibility, cancellation, retries with jitter and rate-limit handling. Never forward sensitive prompts to a fallback provider without authorization.

## Account management
Multiple accounts per provider with labels, Space ownership, quota visibility when supported, per-Space and per-project defaults, per-run account override, credential revocation, secret rotation, and audit. Keep personal and team credentials isolated. Local keychain for desktop secrets; server-side secret vault for cloud credentials; never sync raw secrets through ordinary workspace state.

## SDK shape
ProviderAdapter: `listModels`, `getCapabilities`, `validateConnection`, `generate`, `stream`, `countTokens?`, `estimateCost?`, `cancel?`. Tool calling uses a normalized protocol with raw provider escape hatches. Version the adapter API and provide contract tests and a mock provider.
