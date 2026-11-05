// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { Sample } from "./suite.js";
import { reviewing } from "./samples-p1c.js";

export const SHA1 = "a".repeat(40);
export const SHA2 = "b".repeat(40);
export const SHA3 = "c".repeat(64);
export const DIGEST = "d".repeat(64);

export const completed = { ...structuredClone(reviewing), state: "COMPLETED", endedAt: "2026-11-04T10:00:09.000Z" };

export const file = {
  displayPath: "src/a.ts",
  status: "M",
  kind: "text",
  additions: 3,
  deletions: 1,
  unsafePath: false,
  truncated: false,
  acknowledged: false,
  protectedRules: [] as string[],
  warnings: [] as string[],
};
export const renamed = {
  displayPath: "src/new.ts",
  displayOldPath: "src/old.ts",
  status: "R",
  kind: "text",
  similarity: 90,
  unsafePath: false,
  truncated: true,
  acknowledged: true,
  protectedRules: ["ci-workflow"],
  fileLevelReason: "renamed",
  warnings: ["binary"],
};
export const diffResponse = {
  head: SHA1,
  branch: "axis/fix-it",
  treeHash: SHA2,
  files: [file, renamed],
  skipped: [{ displayPath: "big.bin", size: 60_000_000, reason: "too_large_to_review" }],
  skippedCount: 1,
};
export const plan = {
  remote: "origin",
  branch: "axis/fix-it",
  tip: SHA1,
  requiresConfirmation: true,
  reasons: ["the outgoing history matches 1 secret pattern(s) (aws-access) in commit(s) aaaaaaaaaaaa"],
  findings: [{ rule: "aws-access", path: "config/app.env", line: 4, commit: SHA1 }, { rule: "private-key" }],
  findingsTruncated: false,
  digest: DIGEST,
};

/** Optional and nullable fields replaced by null or a string stay valid or are refused as the schema says; these are the valid ones. */
const NULLABLE = /^null at (branch|treeHash)$/;

export const P1B_SAMPLES: readonly Sample[] = [
  { contract: "axis.git", method: "pushPlan", side: "request", name: "minimal", value: { workspaceId: "ws-1", remote: "origin" } },
  { contract: "axis.git", method: "pushPlan", side: "request", name: "with binary paths", value: { workspaceId: "ws-1", remote: "origin", allowedBinaryPaths: ["assets/logo.png"] } },
  { contract: "axis.git", method: "pushPlan", side: "response", name: "findings by rule and path", value: plan },
  { contract: "axis.git", method: "pushPlan", side: "response", name: "clean plan", value: { ...plan, requiresConfirmation: false, reasons: [], findings: [] } },
  { contract: "axis.git", method: "commit", side: "request", name: "minimal", value: { workspaceId: "ws-1", reviewedTreeHash: SHA2, expectedParent: SHA1, expectedBranch: "axis/fix-it", message: "fix: the thing\n\nBody." } },
  { contract: "axis.git", method: "commit", side: "request", name: "sha-256 ids and author", value: { workspaceId: "ws-1", reviewedTreeHash: SHA3, expectedParent: SHA3, expectedBranch: "axis/a", message: "m", author: { name: "Dylan Lambertson", email: "me@example.com" } } },
  { contract: "axis.git", method: "commit", side: "response", name: "commit", value: { commit: SHA1, tree: SHA2 } },
  { contract: "axis.git", method: "push", side: "request", name: "first request", value: { workspaceId: "ws-1", remote: "origin", confirmedPlan: { tip: SHA1, digest: DIGEST } } },
  { contract: "axis.git", method: "push", side: "request", name: "retry with approval", value: { workspaceId: "ws-1", remote: "origin", confirmedPlan: { tip: SHA1, digest: DIGEST }, allowedBinaryPaths: ["a.png"], approval: { challengeId: "A".repeat(43), originalRequestId: "req-1" } } },
  { contract: "axis.git", method: "push", side: "response", name: "pushed", value: { remote: "origin", branch: "axis/fix-it", tip: SHA1 } },
  { contract: "axis.git", method: "compareUrl", side: "request", name: "minimal", value: { workspaceId: "ws-1", remote: "origin" } },
  { contract: "axis.git", method: "compareUrl", side: "request", name: "with base", value: { workspaceId: "ws-1", remote: "origin", base: "main" } },
  { contract: "axis.git", method: "compareUrl", side: "response", name: "url", value: { url: "https://github.com/owner/repo/compare/main...axis/fix-it" } },
  { contract: "axis.review", method: "diff", side: "request", name: "diff", value: { workspaceId: "ws-1" } },
  { contract: "axis.review", method: "diff", side: "request", name: "with acknowledgements", value: { workspaceId: "ws-1", acknowledged: ["src/new.ts"] } },
  { contract: "axis.review", method: "diff", side: "response", name: "files", value: diffResponse, toleratedPattern: NULLABLE },
  { contract: "axis.review", method: "diff", side: "response", name: "detached or blocked", value: { ...diffResponse, branch: null, treeHash: null, files: [], skipped: [], skippedCount: 0 } },
  { contract: "axis.review", method: "complete", side: "request", name: "complete", value: { runId: "run-1" } },
  { contract: "axis.review", method: "complete", side: "response", name: "completed run", value: { run: completed }, toleratedPattern: /^(null|string) at run\.(agentId|reason|exitCode|lastOutputAt)$/ },
];
