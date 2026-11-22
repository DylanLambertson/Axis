// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Fixed vectors of axis.pages/1 (PV-Q1 slice 1).
import type { Sample } from "./suite.js";

export const T0 = "2026-11-22T10:00:00.000Z";
export const T1 = "2026-11-22T10:00:05.000Z";

export const userMeta = {
  pageId: "page-1", seq: 1, title: "Release plan", author: { kind: "user" }, hop: 0, untrusted: false, reviewed: false, restoredFrom: null, createdAt: T0,
};
export const agentMeta = {
  pageId: "page-1", seq: 2, title: "Release plan", author: { kind: "agent", agentId: "agent-a" }, hop: 3, untrusted: true, reviewed: false, restoredFrom: null, createdAt: T1,
};
export const pluginMeta = {
  pageId: "page-1", seq: 3, title: "Release plan", author: { kind: "plugin", pluginId: "acme.notes" }, hop: 0, untrusted: false, reviewed: true, restoredFrom: 1, createdAt: T1,
};
const version = (meta: object, body = "# Plan\n\n- ship") => ({ meta, body });
const summary = { pageId: "page-1", projectId: "proj-1", current: agentMeta, createdAt: T0, updatedAt: T1 };

const P = "axis.pages";
const req = (method: string, name: string, value: unknown, extra: Partial<Sample> = {}): Sample => ({ contract: P, method, side: "request", name, value, ...extra });
const res = (method: string, name: string, value: unknown, extra: Partial<Sample> = {}): Sample => ({ contract: P, method, side: "response", name, value, ...extra });

export const PAGES_SAMPLES: readonly Sample[] = [
  req("list", "a project's pages", { projectId: "proj-1" }),
  res("list", "one page", { pages: [summary] }),
  req("get", "the newest", { pageId: "page-1" }),
  req("get", "version 2", { pageId: "page-1", seq: 2 }),
  res("get", "an agent's version", { version: version(agentMeta) }),
  req("versions", "versions", { pageId: "page-1" }),
  res("versions", "three", { versions: [pluginMeta, agentMeta, userMeta] }, { tolerated: ["null at versions.0.restoredFrom"] }),
  req("create", "a page", { projectId: "proj-1", title: "Release plan", body: "# Plan" }),
  res("create", "its first version", { version: version(userMeta) }),
  req("update", "an edit", { pageId: "page-1", baseSeq: 2, title: "Release plan", body: "# Plan v2" }),
  res("update", "the new version", { version: version(agentMeta) }),
  req("restore", "version 1", { pageId: "page-1", seq: 1, baseSeq: 2 }),
  res("restore", "the copy", { version: version(pluginMeta) }, { tolerated: ["null at version.meta.restoredFrom"] }),
  req("markReviewed", "with its approval", { pageId: "page-1", seq: 2, approval: { challengeId: "A".repeat(43) } }),
  res("markReviewed", "marked", { version: { ...agentMeta, untrusted: false, reviewed: true }, changed: true }),
  req("delete", "with its approval", { pageId: "page-1", approval: { challengeId: "A".repeat(43) } }),
  res("delete", "deleted", { deleted: true }),
];
