// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Fixed vectors of axis.integrations/1 and axis.net/1 (PV-N1a).
import type { Sample } from "./suite.js";

export const github = {
  id: "github",
  label: "GitHub",
  origins: ["https://api.github.com"],
  operations: [{ operation: "list_pull_requests", write: false }, { operation: "comment_pull_request", write: true }],
  declaredScopes: ["repo:read", "issues:write"],
  grantedScopes: ["repo:read"],
  state: "connected",
};
export const idle = { ...structuredClone(github), id: "linear", label: "Linear", origins: ["https://api.linear.app", "https://xn--bcher-kva.example"], grantedScopes: [], state: "available" };

const I = "axis.integrations";
const N = "axis.net";
const req = (contract: string, method: string, name: string, value: unknown, extra: Partial<Sample> = {}): Sample => ({ contract, method, side: "request", name, value, ...extra });
const res = (contract: string, method: string, name: string, value: unknown, extra: Partial<Sample> = {}): Sample => ({ contract, method, side: "response", name, value, ...extra });
/** Variants a free-form typed subtree (arguments, a result, a body) legitimately accepts: its values are the connector's, not this schema's. */
const FREE = /\bat (args|result|body)(\.|$)/;
const challenge = { challengeId: "A".repeat(43) };

export const INTEGRATIONS_SAMPLES: readonly Sample[] = [
  req(I, "list", "a project's integrations", { projectId: "proj-1" }),
  res(I, "list", "two integrations", { integrations: [github, idle] }),
  req(I, "status", "one integration", { projectId: "proj-1", integrationId: "github" }),
  res(I, "status", "connected", { integration: github }),
  req(I, "connect", "start the device flow", { projectId: "proj-1", integrationId: "github" }),
  req(I, "connect", "after a challenge", { projectId: "proj-1", integrationId: "github", approval: challenge }),
  res(I, "connect", "connecting", { integration: { ...idle, state: "connecting" }, changed: true }),
  req(I, "disconnect", "disconnect", { projectId: "proj-1", integrationId: "github" }),
  res(I, "disconnect", "disconnected", { integration: idle, changed: true }),
  req(I, "read", "a read with arguments", { projectId: "proj-1", integrationId: "github", operation: "list_pull_requests", args: { state: "open", perPage: 30, draft: false } }, { toleratedPattern: FREE }),
  req(I, "read", "a read without arguments", { projectId: "proj-1", integrationId: "github", operation: "list_pull_requests" }),
  req(I, "write", "a write after its challenge", {
    projectId: "proj-1", integrationId: "github", operation: "comment_pull_request", args: { number: 7, body: "LGTM\nthanks" }, approval: challenge,
  }, { toleratedPattern: FREE }),
  res(I, "read", "a typed result", { status: 200, result: { items: [{ number: 7, title: "Fix", draft: false, labels: ["a", "b"], milestone: null }], total: 1 } }, { toleratedPattern: FREE }),
  req(N, "read", "a GET", { projectId: "proj-1", origin: "https://api.example.com", path: "/v1/items?limit=10&after=a%20b", method: "GET" }),
  req(N, "read", "a HEAD", { projectId: "proj-1", origin: "https://api.example.com", path: "/v1/items", method: "HEAD" }),
  req(N, "send", "a POST with a JSON object", { projectId: "proj-1", origin: "https://api.example.com", path: "/v1/items", body: { name: "x", tags: ["a"], n: 1 } }, { toleratedPattern: FREE }),
  req(N, "send", "a POST with no body after a challenge", { projectId: "proj-1", origin: "https://api.example.com", path: "/v1/ping", approval: challenge }),
  res(N, "read", "a JSON body", { status: 201, body: { id: "abc", ok: true } }, { toleratedPattern: FREE }),
  res(N, "send", "the answer", { status: 201, body: { id: "abc" } }, { toleratedPattern: FREE }),
];
