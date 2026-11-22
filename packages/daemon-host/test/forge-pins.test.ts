// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// PV-D2 slice 2: the forge service's pin store. Slice 2 keeps the pin in memory (a named departure: persisted in journal v13,
// slice 2b), so a restart fails closed: the project is unconfirmed again and no `gh` runs until the user confirms. The service
// trusts nothing a store returns beyond a vetted repository, and does not depend on getting the same object back.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ForgeListRequest, ForgeRepository } from "@axis/protocol";
import { createForgeService, createMemoryPinStore, type ForgeServiceDeps, type PinStore } from "../src/index.js";

const REPO: ForgeRepository = { host: "github.com", owner: "acme", repo: "app" };
const okReply = (req: ForgeListRequest) => ({ t: "forge-result", req: req.req, exit: 0, class: "none", stdout: "[]", truncated: false });

function service(over: Partial<ForgeServiceDeps> = {}) {
  const sent: ForgeListRequest[] = [];
  let n = 0;
  let now = 1_000_000;
  const svc = createForgeService({
    projectExists: (id) => id === "p1",
    readOrigin: async () => ({ kind: "url", url: "https://github.com/acme/app.git" }),
    port: { list: async (req) => (sent.push(req), okReply(req)) },
    audit: { append: () => undefined },
    monotonic: () => (now += 20_000),
    requestId: () => `r${++n}`,
    ...over,
  });
  return { svc, sent };
}

test("restart with the in-memory store: the pin is gone, the project is unconfirmed and no gh runs until the user confirms again", async () => {
  const first = service();
  await first.svc.pinRepository("p1", REPO);
  assert.equal((await first.svc.pullRequests("p1", "user")).state, "ok");
  assert.equal(first.sent.length, 1);

  const restarted = service(); // a new host process: a fresh in-memory store
  for (const trigger of ["view", "user"] as const) {
    assert.deepEqual(await restarted.svc.pullRequests("p1", trigger), { state: "repository_unconfirmed", candidate: REPO });
  }
  assert.equal(restarted.sent.length, 0, "nothing ran before the user confirmed again");
  await restarted.svc.pinRepository("p1", REPO);
  assert.equal((await restarted.svc.pullRequests("p1", "user")).state, "ok");
  assert.equal(restarted.sent.length, 1);
});

test("a store that keeps the pin (the slice 2b shape) carries it across service instances; the service writes through the store", async () => {
  const pins = createMemoryPinStore();
  await service({ pins }).svc.pinRepository("p1", REPO);
  assert.deepEqual(pins.get("p1"), REPO);
  const next = service({ pins });
  assert.equal((await next.svc.pullRequests("p1", "user")).state, "ok");
  assert.equal(next.sent.length, 1);
});

test("a store that answers a fresh copy on every read (as a journal row would) still serves the list; only a re-pin makes an answer stale", async () => {
  const held = new Map<string, ForgeRepository>();
  const pins: PinStore = { get: (id) => (held.has(id) ? { ...(held.get(id) as ForgeRepository) } : undefined), set: (id, r) => void held.set(id, { ...r }) };
  const s = service({ pins });
  await s.svc.pinRepository("p1", REPO);
  assert.equal((await s.svc.pullRequests("p1", "user")).state, "ok");
  assert.equal((await s.svc.pullRequests("p1", "view")).state, "ok", "the cached list is served under the same pin");
});

test("a stored value that is not a vetted github.com repository is no pin: unconfirmed, nothing runs", async () => {
  const bad: unknown[] = [
    { host: "gitlab.com", owner: "acme", repo: "app" },
    { host: "github.com", owner: "acme", repo: ".." },
    { host: "github.com", owner: "-acme", repo: "app" },
    { host: "github.com", owner: "acme", repo: "app", extra: 1 },
    { host: "github.com", owner: "acme" },
  ];
  for (const value of bad) {
    const s = service({ pins: { get: () => value as ForgeRepository, set: () => undefined } });
    assert.deepEqual(await s.svc.pullRequests("p1", "user"), { state: "repository_unconfirmed", candidate: REPO }, JSON.stringify(value));
    assert.equal(s.sent.length, 0);
  }
});
