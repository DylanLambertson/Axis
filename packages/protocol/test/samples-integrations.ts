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

/** The path spelling table: the contract schema and the daemon's composition re-check (PV-N1e) judge it alike. */
export const NET_PATHS_ACCEPTED = ["/", "/v1", "/a;b/c", "/x?u=//y", "/..a;b", "/v1/items/", "/v1/items?limit=10&after=a%20b", "/a.b/c..d/...", "/a%2Eb", "/~user/@x", "/a:b;c=d", "/..a/b..", "/%41", "/x?next=%2e%2e", "/x?pct=%25", "/x".padEnd(2048, "a")];
export const NET_PATHS_REFUSED = [
  "/%25", "/%2541", "/a/%25%32%65%25%32%65/b", "/a/%2532%2565/b", "/%25%35%63", "/a%25b",
  "", "v1", "/a\r\nHost: evil", "/a\nb", "/a\rb", "/a\tb", "/a b", "/a\u0000b", "/a\u007fb", "/a\u0085b", "/a\\b", "/a#frag", "/a\"b", "/a<b", "/é", "/a‮b",
  "//", "//evil.com/x", "//evil.com", "/a//b", "/x//", "/..;/x", "/x/..;/y", "/.;/x", "/..;", "/%2e;/x", "/..%3b/x", "/%2e%2e%3b/x", "/x/..%3B/y", "/a%3bb", "/%252e%252e/x", "/%252e/x", "/%252f", "/%255c", "/%c0%ae%c0%ae/x", "/%c0%af", "/%C1%9c", "/%e0%80%af", "/%f0%80%80%af",
  "/.", "/..", "/./x", "/x/..", "/x/../y", "/x/./y", "/%2e", "/%2E", "/%2e%2e", "/%2E%2e", "/.%2e", "/%2e./x", "/x/%2E%2E/y", "/x/%2e", "/x/.%2E/y",
  "/a%2fb", "/a%2Fb", "/a%5cb", "/a%5Cb", "/x?q=%2f", "/x?q=%5c", "/a%00b", "/a%0db", "/a%0Ab", "/a%1fb", "/a%7fb", "/a%", "/a%2", "/a%zz", "/a?b?c", "/x".padEnd(2049, "a"),
];
