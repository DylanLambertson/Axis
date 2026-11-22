// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// axis.pages/1 (PV-Q1 slice 1, ADR 0010): planned, never served; no author, hop or trust in any request; closed refusals.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_PAGE_BODY_BYTES,
  PAGES_REASONS,
  PAGES_REFUSALS,
  contracts,
  isPagesRefusal,
  lookupMethod,
  lookupMethodIn,
  pagesMethods,
  plannedContracts,
  tableProblems,
} from "../src/index.js";
import { PAGES_SAMPLES, agentMeta, userMeta } from "./samples-pages.js";
import { accepts, rejects, runSuite, schemaOf } from "./suite.js";

runSuite(PAGES_SAMPLES);

test("the contract is planned, never served, with the designed method table", () => {
  assert.equal(contracts["axis.pages/1"], undefined);
  assert.equal(lookupMethod("axis.pages", 1, "create"), undefined);
  assert.equal(lookupMethodIn(plannedContracts, "axis.pages", 1, "delete"), pagesMethods.delete);
  assert.deepEqual(tableProblems(plannedContracts), []);
  assert.deepEqual(Object.entries(pagesMethods).map(([m, s]) => [m, s.sideEffect, s.tier, s.idempotency]), [
    ["list", "read", 0, "none"], ["get", "read", 0, "none"], ["versions", "read", 0, "none"], ["create", "write", 1, "required"],
    ["update", "write", 1, "none"], ["restore", "write", 1, "none"], ["markReviewed", "write", 3, "none"], ["delete", "destructive", 3, "none"],
  ]);
});

test("no request names an author, a hop, a trust flag, a review mark or a path", () => {
  const update = schemaOf("axis.pages", "update", "request");
  const base = { pageId: "page-1", baseSeq: 1, title: "T", body: "b" };
  accepts(update, base, "a plain edit");
  for (const extra of [{ author: { kind: "user" } }, { hop: 0 }, { untrusted: false }, { reviewed: true }, { restoredFrom: 1 }, { path: "/tmp/x" }, { createdBy: "user" }]) {
    rejects(update, { ...base, ...extra }, JSON.stringify(extra));
  }
  rejects(schemaOf("axis.pages", "create", "request"), { projectId: "proj-1", title: "T", body: "b", author: { kind: "agent", agentId: "a" } }, "create with an author");
});

test("titles and bodies: the name rule, 256 KiB of UTF-8, no NUL or lone surrogate", () => {
  const create = schemaOf("axis.pages", "create", "request");
  const ok = (title: string, body: string, label: string): void => accepts(create, { projectId: "proj-1", title, body }, label);
  const no = (title: string, body: string, label: string): void => rejects(create, { projectId: "proj-1", title, body }, label);
  ok("t".repeat(200), "", "a 200-character title, an empty body");
  ok("Ünïcødé", "é".repeat(MAX_PAGE_BODY_BYTES / 2), "a body of exactly 256 KiB of UTF-8");
  ok("T", "😀 emoji pairs are fine", "a surrogate pair");
  no("T", "é".repeat(MAX_PAGE_BODY_BYTES / 2 + 1), "one byte over");
  no("T", "x".repeat(MAX_PAGE_BODY_BYTES + 1), "over in units");
  no("T", "a\u0000b", "a NUL");
  no("T", "a\ud800b", "a lone surrogate");
  for (const title of ["", " a", "a ", "t".repeat(201), "a\u0001b", "a‮b", "a b", "a b"]) no(title, "b", `title ${JSON.stringify(title)}`);
});

test("a version's trust is consistent: hop only on untrusted or reviewed text; only the user writes trusted text", () => {
  const get = schemaOf("axis.pages", "get", "response");
  const v = (meta: object) => ({ version: { meta, body: "b" } });
  accepts(get, v(agentMeta), "an untrusted agent version");
  accepts(get, v({ ...agentMeta, untrusted: false, reviewed: true }), "a reviewed agent version keeps its hop");
  rejects(get, v({ ...agentMeta, untrusted: false }), "an agent version that is neither untrusted nor reviewed");
  rejects(get, v({ ...userMeta, hop: 2 }), "a trusted user version with a hop");
  rejects(get, v({ ...userMeta, restoredFrom: 1 }), "a restore from itself");
  rejects(get, v({ ...agentMeta, hop: 9 }), "hop over 8");
  rejects(get, v({ ...agentMeta, author: { kind: "plugin", pluginId: "a".repeat(65) } }), "a plugin id over 64");
  rejects(get, v({ ...agentMeta, author: { kind: "admin" } }), "an unknown author");
});

test("tier-3 methods take an optional approval; the refusals are closed", () => {
  for (const m of ["markReviewed", "delete"]) {
    const s = schemaOf("axis.pages", m, "request");
    accepts(s, { pageId: "p", ...(m === "markReviewed" ? { seq: 1 } : {}) }, `${m} without an approval`);
    rejects(s, { pageId: "p", seq: 1, approval: { challengeId: "x" } }, `${m} with a bad approval`);
  }
  assert.deepEqual(Object.keys(PAGES_REFUSALS), ["E_NOT_FOUND", "E_INVALID_ARGUMENT", "E_CONFLICT"]);
  assert.equal(new Set(PAGES_REASONS).size, PAGES_REASONS.length);
  assert.equal(isPagesRefusal("E_CONFLICT", "stale_version"), true);
  assert.equal(isPagesRefusal("E_NOT_FOUND", "stale_version"), false);
  assert.equal(isPagesRefusal("toString", "not_found"), false);
});

test("list and versions stay at their caps", () => {
  const versions = schemaOf("axis.pages", "versions", "response");
  accepts(versions, { versions: Array.from({ length: 100 }, () => structuredClone(agentMeta)) }, "100");
  rejects(versions, { versions: Array.from({ length: 101 }, () => structuredClone(agentMeta)) }, "101");
});
