// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// PV-K1e-a2: the optional closed `requester` of a listed challenge and `axis.approvals/1.detail`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_DETAIL_PROMPT, MAX_LISTED_SUMMARY, MAX_PLUGIN_CHALLENGES_PER_WINDOW, approvalsMethods } from "../src/index.js";
import { challengeA } from "./samples-p1a.js";
import { accepts, rejects, schemaOf } from "./suite.js";

const pendingRes = () => schemaOf("axis.approvals", "pending", "response");
const detailReq = () => schemaOf("axis.approvals", "detail", "request");
const detailRes = () => schemaOf("axis.approvals", "detail", "response");
const ID = `C${"0".repeat(63)}`;
const plugin = { kind: "plugin", pluginId: "acme.board" };
const detail = (over: Record<string, unknown> = {}) => ({
  kind: "runs.start",
  requester: plugin,
  prompt: "Summarise the open tasks",
  project: "One",
  workspace: "feature-x",
  mode: "edit",
  provider: "anthropic",
  model: "claude-opus-5-5",
  ...over,
});

test("detail is a tier-0 read with no idempotency", () => {
  assert.deepEqual({ ...approvalsMethods.detail, request: undefined, response: undefined }, { request: undefined, response: undefined, sideEffect: "read", tier: 0, idempotency: "none", timeoutMs: 5_000 });
});

test("a listed challenge may name a plugin requester, closed in shape", () => {
  accepts(pendingRes(), { challenges: [{ ...challengeA, requester: plugin }] }, "plugin requester");
  accepts(pendingRes(), { challenges: [challengeA] }, "no requester: unchanged");
  for (const bad of [{ kind: "user" }, { kind: "agent", pluginId: "acme" }, { kind: "plugin" }, { kind: "plugin", pluginId: "Acme" }, { kind: "plugin", pluginId: "acme", extra: 1 }, { kind: "plugin", pluginId: `a${"b".repeat(64)}` }, "plugin:acme", null]) {
    rejects(pendingRes(), { challenges: [{ ...challengeA, requester: bad }] }, JSON.stringify(bad));
  }
});

test("at most 4 listed challenges name a requester, and a full listing with 4 worst-case requesters fits one message", () => {
  const fat = (i: number, requester?: unknown) => ({
    ...challengeA,
    challengeId: `C${String(i).padStart(63, "0")}`,
    contract: `a${"b".repeat(63)}`,
    method: `A${"b".repeat(63)}`,
    targetSummary: "€".repeat(MAX_LISTED_SUMMARY),
    // A fresh copy each time: one object shared by two entries is itself refused (aliasing).
    ...(requester === undefined ? {} : { requester: structuredClone(requester) }),
  });
  const longest = { kind: "plugin", pluginId: `a${"b".repeat(14)}.c${"d".repeat(14)}.e${"f".repeat(14)}.g${"h".repeat(15)}` };
  assert.equal(longest.pluginId.length, 64);
  assert.equal(MAX_PLUGIN_CHALLENGES_PER_WINDOW, 4);
  const full = Array.from({ length: 1024 }, (_, i) => fat(i, i < 4 ? longest : undefined));
  accepts(pendingRes(), { challenges: full }, "1024 challenges, 4 with the longest requester");
  rejects(pendingRes(), { challenges: full.map((c, i) => (i === 4 ? fat(i, longest) : c)) }, "a fifth requester");
});

test("detail request: a challenge id only", () => {
  accepts(detailReq(), { challengeId: ID }, "id");
  rejects(detailReq(), {}, "empty");
  for (const k of ["windowId", "actor", "pluginId", "connectionId"]) rejects(detailReq(), { challengeId: ID, [k]: "x" }, k);
});

test("detail response: exact fields, the prompt whole up to the cap and escaped, nothing more", () => {
  accepts(detailRes(), { challengeId: ID, detail: detail() }, "detail");
  accepts(detailRes(), { challengeId: ID, detail: detail({ prompt: "€".repeat(MAX_DETAIL_PROMPT) }) }, "the longest prompt (3-byte units) fits one message");
  rejects(detailRes(), { challengeId: ID, detail: detail({ prompt: "x".repeat(MAX_DETAIL_PROMPT + 1) }) }, "past the cap");
  for (const [k, v] of [["prompt", ""], ["prompt", "a\u0000b"], ["prompt", "a‮b"], ["prompt", "a​b"], ["project", "a\u0007"], ["mode", "drive"], ["provider", "Anthropic"], ["model", "a b"], ["kind", "runs.stop"]] as const) {
    rejects(detailRes(), { challengeId: ID, detail: detail({ [k]: v }) }, `${k}=${JSON.stringify(v)}`);
  }
  accepts(detailRes(), { challengeId: ID, detail: detail({ prompt: "line one\nline\ttwo \\u{0}" }) }, "tab, line feed and an escape sequence are text");
  for (const k of ["kind", "requester", "prompt", "project", "workspace", "mode", "provider", "model"]) {
    const d: Record<string, unknown> = detail();
    delete d[k];
    rejects(detailRes(), { challengeId: ID, detail: d }, `without ${k}`);
  }
  rejects(detailRes(), { challengeId: ID, detail: detail({ digest: "x" }) }, "extra key");
  rejects(detailRes(), { challengeId: ID, detail: detail(), extra: 1 }, "extra top-level key");
  rejects(detailRes(), { challengeId: ID, detail: detail({ requester: { kind: "plugin", pluginId: "acme", verified: true } }) }, "requester extra key");
});

test("E_APPROVAL_REQUIRED details: the whole challenge, or (for a plugin) the challenge id alone, and nothing in between", async () => {
  const { errorSchema, approvalRequiredDetailsSchema, pluginApprovalRequiredDetailsSchema } = await import("../src/index.js");
  const err = (details: unknown) => ({ code: "E_APPROVAL_REQUIRED", message: "Confirmation required", retryable: false, correlationId: "c1", details });
  accepts(errorSchema, err({ challenge: challengeA }), "the whole challenge");
  accepts(errorSchema, err({ challenge: { challengeId: ID } }), "the id alone");
  rejects(errorSchema, err({ challenge: { challengeId: ID, targetSummary: "x" } }), "the id plus a field");
  rejects(errorSchema, err({ challenge: {} }), "no id");
  rejects(errorSchema, err({ challenge: { challengeId: "short" } }), "a bad id");
  // A user client still parses the whole challenge: the id-only form never satisfies the ordinary schema.
  assert.equal(approvalRequiredDetailsSchema.safeParse({ challenge: { challengeId: ID } }).success, false);
  assert.equal(pluginApprovalRequiredDetailsSchema.safeParse({ challenge: challengeA }).success, false);
});
