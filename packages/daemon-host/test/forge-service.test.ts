// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// PV-D2 §2, §6, §7: repository confirmation, the reply mapping, cache, triggers and latches, and that nothing a pull request
// author wrote reaches an audit row, a log line, an error or the port request.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AuditEventInput } from "@axis/audit";
import { forgeMethods, type ForgeListRequest } from "@axis/protocol";
import { createForgeService, createMemoryPinStore, ForgeRefusal, type ForgeServiceDeps, type OriginRead } from "../src/index.js";

const CANARY = "CANARY7f3a";
const goodRow = (n: number, over: Record<string, unknown> = {}) => ({
  number: n,
  title: `Title ${CANARY}`,
  headRefName: `axis/${CANARY}`,
  author: { login: `u${CANARY}` },
  isDraft: false,
  isCrossRepository: false,
  headRepositoryOwner: { login: "acme" },
  reviewDecision: "APPROVED",
  statusCheckRollup: [],
  ...over,
});
const listing = (rows: unknown[]) => JSON.stringify(rows);

interface Rig {
  readonly svc: ReturnType<typeof createForgeService>;
  readonly sent: ForgeListRequest[];
  readonly audit: AuditEventInput[];
  readonly logs: string[];
  origin: OriginRead;
  now: number;
  reply: (req: ForgeListRequest) => unknown;
}

function rig(over: Partial<ForgeServiceDeps> = {}, projects = ["p1", "p2"]): Rig {
  let n = 0;
  const r: Rig = {
    svc: undefined as unknown as Rig["svc"],
    sent: [],
    audit: [],
    logs: [],
    origin: { kind: "url", url: "https://github.com/acme/app.git" },
    now: 1_000_000,
    reply: (req) => ({ t: "forge-result", req: req.req, exit: 0, class: "none", stdout: listing([goodRow(1)]), truncated: false }),
  };
  const svc = createForgeService({
    projectExists: (id) => projects.includes(id),
    readOrigin: async () => r.origin,
    port: { list: async (req) => (r.sent.push(req), r.reply(req)) },
    audit: { append: (e) => void r.audit.push(e) },
    monotonic: () => r.now,
    requestId: () => `r${++n}`,
    log: (l) => void r.logs.push(l),
    pins: createMemoryPinStore(),
    ...over,
  });
  (r as { svc: unknown }).svc = svc;
  return r;
}

const confirm = async (r: Rig, id = "p1"): Promise<void> => {
  const a = await r.svc.pullRequests(id, "view");
  assert.equal(a.state, "repository_unconfirmed");
  await r.svc.pinRepository(id, a.candidate as never);
};
const valid = (a: unknown): void => assert.equal(forgeMethods.pullRequests.response.safeParse(a).success, true, JSON.stringify(a));

test("an unknown project is refused with a closed reason", async () => {
  const r = rig();
  await assert.rejects(r.svc.pullRequests("nope", "view"), (e) => e instanceof ForgeRefusal && e.reason === "not_found" && e.message === "forge request refused");
  await assert.rejects(r.svc.pinRepository("nope", { host: "github.com", owner: "acme", repo: "app" }), ForgeRefusal);
});

test("the remote decides the early states, and nothing runs before the user confirms the repository", async () => {
  const cases: [OriginRead, string][] = [
    [{ kind: "none" }, "no_remote"],
    [{ kind: "url", url: "https://github.com/acme/../x" }, "remote_invalid"],
    [{ kind: "url", url: "file:///tmp/x" }, "remote_invalid"],
    [{ kind: "url", url: "https://gitlab.com/acme/app.git" }, "other_forge"],
    [{ kind: "url", url: "https://ghe.corp.example/acme/app.git" }, "unsupported_host"],
  ];
  const r = rig({ enterpriseHosts: new Set(["ghe.corp.example"]) });
  for (const [origin, state] of cases) {
    r.origin = origin;
    const a = await r.svc.pullRequests("p1", "user");
    assert.equal(a.state, state, JSON.stringify(origin));
    valid(a);
  }
  const throwing = rig({ readOrigin: async () => { throw new Error(CANARY); } });
  assert.equal((await throwing.svc.pullRequests("p1", "view")).state, "no_remote");
  r.origin = { kind: "url", url: "git@github.com:acme/app.git" };
  const a = await r.svc.pullRequests("p1", "user");
  assert.deepEqual(a, { state: "repository_unconfirmed", candidate: { host: "github.com", owner: "acme", repo: "app" } });
  assert.equal(r.sent.length, 0, "no gh before the first confirmation");
});

test("pinRepository accepts only the value just displayed; a remote edited between display and confirm is refused", async () => {
  const r = rig();
  const a = await r.svc.pullRequests("p1", "view");
  r.origin = { kind: "url", url: "https://github.com/attacker/app.git" };
  await assert.rejects(r.svc.pinRepository("p1", a.candidate as never), (e) => e instanceof ForgeRefusal && e.reason === "candidate_changed");
  assert.equal((await r.svc.pullRequests("p1", "view")).state, "repository_unconfirmed", "nothing was pinned");
  for (const wrong of [{ owner: "Acme", repo: "app" }, { owner: "acme", repo: "App" }, { owner: "acme", repo: "other" }]) {
    r.origin = { kind: "url", url: "https://github.com/acme/app.git" };
    await assert.rejects(r.svc.pinRepository("p1", { host: "github.com", ...wrong }), ForgeRefusal, JSON.stringify(wrong));
  }
  r.origin = { kind: "none" };
  await assert.rejects(r.svc.pinRepository("p1", { host: "github.com", owner: "acme", repo: "app" }), ForgeRefusal);
  r.origin = { kind: "url", url: "https://github.com/acme/app.git" };
  assert.deepEqual(await r.svc.pinRepository("p1", { host: "github.com", owner: "acme", repo: "app" }), { repository: { host: "github.com", owner: "acme", repo: "app" } });
  const pinRow = r.audit.find((e) => e.action === "forge.pin");
  assert.deepEqual(pinRow?.payload, { projectId: "p1", host: "github.com", owner: "acme", repo: "app" });
  const ok = await r.svc.pullRequests("p1", "view");
  assert.equal(ok.state, "ok");
  assert.deepEqual(r.sent, [{ t: "forge-list", req: "r1", host: "github.com", owner: "acme", repo: "app" }]);
});

test("a changed remote stops the list and asks again, showing old and new; re-pinning records both", async () => {
  const r = rig();
  await confirm(r);
  r.origin = { kind: "url", url: "https://github.com/evil/app.git" };
  const a = await r.svc.pullRequests("p1", "user");
  assert.deepEqual(a, { state: "remote_changed", repository: { host: "github.com", owner: "acme", repo: "app" }, candidate: { host: "github.com", owner: "evil", repo: "app" } });
  assert.equal(r.sent.length, 0);
  await r.svc.pinRepository("p1", a.candidate as never);
  assert.deepEqual(r.audit.filter((e) => e.action === "forge.pin")[1]?.payload, { projectId: "p1", fromHost: "github.com", fromOwner: "acme", fromRepo: "app", host: "github.com", owner: "evil", repo: "app" });
});

test("every pty reply maps to its closed state", async () => {
  const res = (over: Record<string, unknown>) => (req: ForgeListRequest) => ({ t: "forge-result", req: req.req, exit: 1, class: "other", stdout: "", truncated: false, ...over });
  const failed = (code: string) => (req: ForgeListRequest) => ({ t: "forge-failed", req: req.req, code });
  const table: [(req: ForgeListRequest) => unknown, string][] = [
    [res({ exit: 0, class: "none", stdout: "not json" }), "output_invalid"],
    [res({ exit: 0, truncated: true, stdout: listing([goodRow(1)]) }), "output_too_large"],
    [res({ class: "auth_missing" }), "not_logged_in"],
    [res({ exit: 4, class: "auth_missing" }), "not_logged_in"],
    [res({ class: "keyring" }), "keyring_unavailable"],
    [res({ class: "repo_missing" }), "repo_not_found"],
    [res({ class: "network" }), "network_unavailable"],
    [res({ class: "other" }), "gh_failed"],
    [res({ class: "none", exit: 2 }), "gh_failed"],
    [failed("spawn_missing"), "gh_missing"],
    [failed("spawn_failed"), "gh_failed"],
    [failed("too_old"), "gh_too_old"],
    [failed("version_unknown"), "gh_failed"],
    [failed("timeout"), "timeout"],
    [failed("capacity"), "busy"],
    [failed("no_control"), "unavailable"],
    [failed("bad_request"), "remote_invalid"],
    [failed("unsupported_platform"), "unsupported_platform"],
    [() => ({ t: "forge-failed", req: "other", code: "timeout" }), "gh_failed"],
    [() => ({ t: "forge-result", req: "r1", exit: 0, class: "none", stdout: "[]", truncated: false, extra: 1 }), "gh_failed"],
    [() => `${CANARY}`, "gh_failed"],
    [() => { throw new Error(CANARY); }, "unavailable"],
  ];
  for (const [reply, state] of table) {
    const r = rig();
    await confirm(r);
    r.reply = reply;
    const a = await r.svc.pullRequests("p1", "user");
    assert.equal(a.state, state, String(reply));
    valid(a);
  }
});

test("without a pty process, or on a platform where the gate failed, nothing runs", async () => {
  const none = rig({ port: undefined } as unknown as Partial<ForgeServiceDeps>);
  await confirm(none);
  assert.equal((await none.svc.pullRequests("p1", "user")).state, "unavailable");
  const unsupported = rig({ authUnsupported: true });
  await confirm(unsupported);
  assert.equal((await unsupported.svc.pullRequests("p1", "user")).state, "auth_unsupported");
  assert.equal(unsupported.sent.length, 0);
});

test("cache: view answers from a list younger than 60 s; user waits 15 s between execs; a list ages to stale", async () => {
  const r = rig();
  await confirm(r);
  assert.equal((await r.svc.pullRequests("p1", "view")).state, "ok");
  r.now += 59_999;
  const cached = await r.svc.pullRequests("p1", "view");
  assert.deepEqual([cached.state, cached.ageMs, r.sent.length], ["ok", 59_999, 1]);
  r.now += 1;
  await r.svc.pullRequests("p1", "view");
  assert.equal(r.sent.length, 2, "60 s old: refreshed");
  r.now += 14_999;
  const early = await r.svc.pullRequests("p1", "user");
  assert.deepEqual([early.retryAfterMs, r.sent.length], [1, 2]);
  r.now += 1;
  await r.svc.pullRequests("p1", "user");
  assert.equal(r.sent.length, 3);
  const old = rig({ limits: { freshMs: 10_000_000 } });
  await confirm(old);
  await old.svc.pullRequests("p1", "view");
  old.now += 600_000;
  assert.equal((await old.svc.pullRequests("p1", "view")).stale, true);
  const fresh = rig({ limits: { freshMs: 10_000_000 } });
  await confirm(fresh);
  await fresh.svc.pullRequests("p1", "view");
  fresh.now += 599_999;
  assert.equal((await fresh.svc.pullRequests("p1", "view")).stale, undefined);
});

test("a failure is cached for 15 s for view; single flight joins concurrent requests", async () => {
  const r = rig();
  await confirm(r);
  r.reply = (req) => ({ t: "forge-failed", req: req.req, code: "spawn_failed" });
  await r.svc.pullRequests("p1", "view");
  r.now += 14_999;
  assert.equal((await r.svc.pullRequests("p1", "view")).state, "gh_failed");
  assert.equal(r.sent.length, 1);
  r.now += 1;
  await r.svc.pullRequests("p1", "view");
  assert.equal(r.sent.length, 2);
  let release: (v: unknown) => void = () => {};
  r.reply = (req) => new Promise((res) => (release = () => res({ t: "forge-result", req: req.req, exit: 0, class: "none", stdout: "[]", truncated: false })));
  r.now += 15_000;
  const a = r.svc.pullRequests("p1", "user");
  const b = r.svc.pullRequests("p1", "view");
  await new Promise((res) => setImmediate(res));
  release(undefined);
  assert.deepEqual([(await a).state, (await b).state, r.sent.length], ["ok", "ok", 3]);
});

test("latch: an auth failure stops view in every project; only user runs again, at most once per 15 s; success clears it", async () => {
  const r = rig();
  await confirm(r, "p1");
  await confirm(r, "p2");
  r.reply = (req) => ({ t: "forge-result", req: req.req, exit: 1, class: "auth_missing", stdout: "", truncated: false });
  assert.equal((await r.svc.pullRequests("p1", "view")).state, "not_logged_in");
  r.now += 3_600_000;
  assert.equal((await r.svc.pullRequests("p1", "view")).state, "not_logged_in");
  const other = await r.svc.pullRequests("p2", "view");
  assert.deepEqual([other.state, other.ageMs], ["not_logged_in", undefined], "a project with no cache answers the latch state");
  assert.equal(r.sent.length, 1, "view never runs while latched");
  await r.svc.pullRequests("p1", "user");
  assert.equal(r.sent.length, 2);
  r.now += 14_999;
  assert.equal((await r.svc.pullRequests("p1", "user")).retryAfterMs, 1);
  assert.equal(r.sent.length, 2, "the 15 s minimum holds while latched");
  r.now += 1;
  r.reply = (req) => ({ t: "forge-result", req: req.req, exit: 0, class: "none", stdout: "[]", truncated: false });
  assert.equal((await r.svc.pullRequests("p1", "user")).state, "ok");
  assert.equal((await r.svc.pullRequests("p2", "view")).state, "ok", "a success clears the global latch");
  assert.equal(r.sent.length, 4);
  // A restarted daemon (a new service) holds no latch.
  const fresh = rig();
  await confirm(fresh);
  assert.equal((await fresh.svc.pullRequests("p1", "view")).state, "ok");
});

test("latch: a timeout latches that project only, and a new pin clears it", async () => {
  const r = rig();
  await confirm(r, "p1");
  await confirm(r, "p2");
  r.reply = (req) => (req.owner === "acme" && r.sent.length === 1 ? { t: "forge-failed", req: req.req, code: "timeout" } : { t: "forge-result", req: req.req, exit: 0, class: "none", stdout: "[]", truncated: false });
  assert.equal((await r.svc.pullRequests("p1", "view")).state, "timeout");
  r.now += 3_600_000;
  assert.equal((await r.svc.pullRequests("p1", "view")).state, "timeout");
  assert.equal((await r.svc.pullRequests("p2", "view")).state, "ok", "another project is not latched by a timeout");
  assert.equal(r.sent.length, 2);
  await r.svc.pinRepository("p1", { host: "github.com", owner: "acme", repo: "app" });
  assert.equal((await r.svc.pullRequests("p1", "view")).state, "ok");
  assert.equal(r.sent.length, 3);
});

test("no attacker text reaches an audit row, a log line, an error or the port request", async () => {
  const r = rig();
  await confirm(r);
  const a = await r.svc.pullRequests("p1", "user");
  assert.equal(a.state, "ok");
  assert.ok(JSON.stringify(a.rows).includes(CANARY), "the escaped rows do carry it, to the user only");
  const stderrish = [
    (req: ForgeListRequest) => ({ t: "forge-result", req: req.req, exit: 1, class: "other", stdout: CANARY, truncated: false }),
    (req: ForgeListRequest) => ({ t: "forge-result", req: req.req, exit: 0, class: "none", stdout: `[${JSON.stringify(goodRow(1, { number: CANARY }))}]`, truncated: false }),
    () => ({ t: "forge-failed", req: "r9", code: CANARY }),
  ];
  for (const reply of stderrish) {
    r.reply = reply;
    r.now += 15_000;
    await r.svc.pullRequests("p1", "user");
  }
  const errs: string[] = [];
  const thrower = rig({ readOrigin: async () => ({ kind: "url", url: `https://github.com/${CANARY}x/app.git` }) });
  try {
    await thrower.svc.pinRepository("p1", { host: "github.com", owner: "acme", repo: "app" });
  } catch (e) {
    errs.push(String(e), JSON.stringify(e), (e as Error).message);
  }
  assert.equal(errs.length, 3);
  for (const blob of [JSON.stringify(r.audit), r.logs.join("\n"), JSON.stringify(r.sent), errs.join("\n")]) assert.equal(blob.includes(CANARY), false, blob);
  assert.deepEqual(Object.keys(r.audit.find((e) => e.action === "forge.pull_requests")?.payload ?? {}).sort(), ["invalidRows", "projectId", "rows", "state", "trigger"]);
  assert.ok(r.logs.every((l) => /^forge: state=[a-z_]+ exit=(none|\d+)$/.test(l)), r.logs.join("|"));
});

test("view with no cache inside the 15 s floor answers busy and sends nothing, whatever the trigger", async () => {
  const r = rig();
  await confirm(r);
  await r.svc.pullRequests("p1", "view");
  // A re-pin clears the cache; the floor still holds for the next view.
  await r.svc.pinRepository("p1", { host: "github.com", owner: "acme", repo: "app" });
  r.now += 5_000;
  const a = await r.svc.pullRequests("p1", "view");
  assert.deepEqual([a.state, a.retryAfterMs, r.sent.length], ["busy", 10_000, 1]);
  valid(a);
  r.now += 10_000;
  assert.equal((await r.svc.pullRequests("p1", "view")).state, "ok");
  assert.equal(r.sent.length, 2);
});

test("a pin changed while gh runs: the exec is audited and logged, its answer is not cached or returned, and no old candidate is offered", async () => {
  const r = rig();
  await confirm(r);
  let release: () => void = () => {};
  r.reply = (req) => new Promise((res) => (release = () => res({ t: "forge-result", req: req.req, exit: 1, class: "auth_missing", stdout: "", truncated: false })));
  const pending = r.svc.pullRequests("p1", "user");
  await new Promise((res) => setImmediate(res));
  r.origin = { kind: "url", url: "https://github.com/acme/other.git" };
  await r.svc.pinRepository("p1", { host: "github.com", owner: "acme", repo: "other" });
  r.now += 3_000;
  release();
  const a = await pending;
  assert.deepEqual(a, { state: "busy", repository: { host: "github.com", owner: "acme", repo: "other" }, retryAfterMs: 12_000 });
  valid(a);
  assert.deepEqual(r.audit.map((e) => e.action).sort(), ["forge.pin", "forge.pin", "forge.pull_requests"]);
  assert.equal(r.audit.filter((e) => e.action === "forge.pull_requests").length, 1, "the exec is audited");
  assert.equal(r.logs.length, 1, "and logged");
  r.now += 12_000;
  r.reply = (req) => ({ t: "forge-result", req: req.req, exit: 0, class: "none", stdout: "[]", truncated: false });
  const next = await r.svc.pullRequests("p1", "view");
  assert.equal(next.state, "ok", "the old answer was not cached under the new pin, and its auth failure set no latch");
  assert.equal(r.sent.length, 2);
  assert.deepEqual(r.sent[1], { t: "forge-list", req: "r2", host: "github.com", owner: "acme", repo: "other" });
});

test("a request id outside the schema is never sent, and a reply that throws while read is gh_failed", async () => {
  const bad = rig({ requestId: () => "bad id!" });
  await confirm(bad);
  assert.equal((await bad.svc.pullRequests("p1", "user")).state, "gh_failed");
  assert.equal(bad.sent.length, 0);
  assert.equal(bad.audit.filter((e) => e.action === "forge.pull_requests").length, 1);
  const r = rig();
  await confirm(r);
  r.reply = () => ({ get t(): string { throw new Error(CANARY); } });
  const a = await r.svc.pullRequests("p1", "user");
  assert.equal(a.state, "gh_failed");
  assert.equal(JSON.stringify([r.audit, r.logs]).includes(CANARY), false);
});

test("re-pin race with an ok answer: the old repository's rows are never served under the new pin, and a case-only re-pin counts", async () => {
  for (const [owner, repo] of [["acme", "other"], ["Acme", "App"]] as const) {
    const r = rig();
    await confirm(r);
    let release: () => void = () => {};
    r.reply = (req) => new Promise((res) => (release = () => res({ t: "forge-result", req: req.req, exit: 0, class: "none", stdout: listing([goodRow(7, { title: "OLD REPO PR" })]), truncated: false })));
    const pending = r.svc.pullRequests("p1", "user");
    await new Promise((res) => setImmediate(res));
    r.origin = { kind: "url", url: `https://github.com/${owner}/${repo}.git` };
    await r.svc.pinRepository("p1", { host: "github.com", owner, repo });
    release();
    assert.equal((await pending).state, "busy", `${owner}/${repo}`);
    // Past the floor and well inside the 60 s freshness: a cached old answer would be served here.
    r.now += 20_000;
    r.reply = (req) => ({ t: "forge-result", req: req.req, exit: 0, class: "none", stdout: listing([goodRow(8, { title: "NEW REPO PR" })]), truncated: false });
    const next = await r.svc.pullRequests("p1", "view");
    assert.equal(r.sent.length, 2, `${owner}/${repo}: a new exec, not a cached old answer`);
    assert.deepEqual([r.sent[1]?.owner, r.sent[1]?.repo], [owner, repo]);
    assert.deepEqual(next.repository, { host: "github.com", owner, repo });
    assert.deepEqual(next.rows?.map((x) => [x.title, x.url]), [[`NEW REPO PR`, `https://github.com/${owner}/${repo}/pull/8`]]);
    assert.equal(JSON.stringify(next).includes("OLD REPO PR"), false);
  }
});
