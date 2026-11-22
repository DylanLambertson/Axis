// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test, type TestContext } from "node:test";
import { READ_PAGE, WRITE_PAGE, createPagesService, lineChange, type PageCaller, type PagesService } from "../src/index.js";
import { composerRig, type ComposerRig } from "./composer-rig.js";
import { approveAll, denyAll, drive, type DeliveryRig } from "./messages-delivery-rig.js";

// PV-Q1 slice 2: `read_page` (IAC-T source 4) and `write_page` (approval by default) through the real broker, approvals and loop.

const USER: PageCaller = { kind: "user" };
const worker = (agentId: string, receivedHop = 0, projectId = "p"): PageCaller => ({ kind: "agent", agentId, projectId, runId: "r-other", receivedHop });

interface PagesRig {
  readonly c: ComposerRig;
  readonly r: DeliveryRig;
  readonly svc: PagesService;
  run(agentId?: string, projectId?: string): string;
  rows(action: string): Record<string, unknown>[];
}

async function pagesRig(t: TestContext): Promise<PagesRig> {
  const holder: { svc?: PagesService } = {};
  const workers = new Map<string, { agentId: string; projectId: string }>();
  const lazy = new Proxy({} as PagesService, { get: (_t, k) => (holder.svc as unknown as Record<string | symbol, unknown>)[k] });
  const c = await composerRig({ replies: [], pages: { service: lazy, workerOf: (id) => workers.get(id) } });
  t.after(() => c.cleanup());
  for (const id of ["p", "q"]) if (c.journal.getProject(id) === undefined) c.journal.registerProject({ id, path: `/repo/${id}`, displayName: id, trusted: false, actor: "user" });
  holder.svc = createPagesService({ journal: c.journal, audit: c.audit, random: { bytes: (n) => randomBytes(n) } });
  return {
    c,
    r: { c } as unknown as DeliveryRig,
    svc: holder.svc,
    run(agentId, projectId = "p") {
      const id = c.journal.composer.createRun({ workspaceId: c.workspaceId, createdBy: "user" }, { mode: "agent", providerId: "mock", modelId: "mock-model" }).value.id;
      c.journal.transitionRun(id, "RUNNING");
      if (agentId !== undefined) workers.set(id, { agentId, projectId });
      return id;
    },
    rows: (action) => c.audit.list({ limit: 2000 }).filter((e) => e.action === action).map((e) => e.payload as Record<string, unknown>),
  };
}
const page = (svc: PagesService, body = "user text", projectId = "p") => svc.create(USER, { projectId, title: "Plan", body }).version.meta;
const readPage = (pageId: string, seq?: number) => ({ name: READ_PAGE, input: seq === undefined ? { pageId } : { pageId, seq } });
const writePage = (input: Record<string, unknown>) => ({ name: WRITE_PAGE, input });

test("read_page of an agent's version taints the run before the text returns: a write in the SAME reply is decided tainted and written at the read's hop", async (t) => {
  const p = await pagesRig(t);
  const pg = page(p.svc);
  p.svc.update(worker("w2", 2), { pageId: pg.pageId, baseSeq: 1, title: "Plan", body: "agent text" });
  const runId = p.run("w1");
  const d = drive(p.r, runId, [[readPage(pg.pageId), writePage({ pageId: pg.pageId, baseSeq: 2, title: "Plan", body: "agent text\nmore" })], []]);
  assert.equal((await Promise.all([approveAll(p.r, d.end), d.end]))[0], 1, "the write waited for the user");
  assert.equal(p.c.journal.composer.tainted(runId), true);
  assert.deepEqual(p.rows("message.taint").map((x) => [x["source"], x["sourceId"], x["senderKind"], x["hop"]]), [["page", `${pg.pageId}:2`, "agent", 2]]);
  const card = d.notes.find((n) => n.state === "requested");
  assert.deepEqual(card?.preview?.taint?.sources.map((x) => [x.source, x.sender, x.hop]), [["page", "w2", 2]], "the card lists the page");
  assert.match(card?.preview?.content?.head ?? "", new RegExp(`^Page: ${pg.pageId} \\(edits version 2\\)\\n\\n@@ line 2: -0 \\+1\\n\\+ more$`));
  const v3 = p.svc.get({ pageId: pg.pageId }).version.meta;
  assert.deepEqual([v3.seq, v3.author, v3.hop, v3.untrusted], [3, { kind: "agent", agentId: "w1" }, 2, true], "written by the worker at the hop it received");
  assert.match(d.results[1]?.[0] ?? "", /^\[axis-page [0-9a-f]{24}\] Page .*may hold text the user did not write[\s\S]*\n\| agent text\n/);
});

test("a user edit after an agent revision still taints a reader; the version the user marked reviewed does not", async (t) => {
  const p = await pagesRig(t);
  const pg = page(p.svc);
  p.svc.update(worker("w2", 1), { pageId: pg.pageId, baseSeq: 1, title: "Plan", body: "agent text" });
  p.svc.update(USER, { pageId: pg.pageId, baseSeq: 2, title: "Plan", body: "agent text, edited by me" });
  const first = p.run("w1");
  await drive(p.r, first, [[readPage(pg.pageId)], []]).end;
  assert.equal(p.c.journal.composer.tainted(first), true, "the user's edit kept the agent's text");
  p.svc.markReviewed({ pageId: pg.pageId, seq: 3 });
  const second = p.run("w1");
  await drive(p.r, second, [[readPage(pg.pageId)], []]).end;
  assert.equal(p.c.journal.composer.tainted(second), false, "the reviewed version is not a source");
  const third = p.run("w1");
  await drive(p.r, third, [[readPage(pg.pageId, 2)], []]).end;
  assert.equal(p.c.journal.composer.tainted(third), true, "an older agent version still is");
});

test("a page only the user wrote taints nothing, yet write_page asks the user even in an untainted run", async (t) => {
  const p = await pagesRig(t);
  const pg = page(p.svc);
  const runId = p.run("w1");
  const d = drive(p.r, runId, [[readPage(pg.pageId)], [writePage({ title: "Notes", body: "new page" })], []]);
  assert.equal((await Promise.all([approveAll(p.r, d.end), d.end]))[0], 1);
  assert.equal(p.c.journal.composer.tainted(runId), false);
  assert.deepEqual(p.rows("message.taint"), []);
  const mine = p.svc.list({ projectId: "p" }).pages.find((x) => x.current.title === "Notes")?.current;
  assert.deepEqual([mine?.author, mine?.hop, mine?.untrusted], [{ kind: "agent", agentId: "w1" }, 0, true]);
  assert.deepEqual(p.rows("page.create").map((x) => [x["callerKind"], x["authorKind"], x["projectId"]]), [["user", "user", "p"], ["agent", "agent", "p"]]);
});

test("a refused read taints nothing: another project's page and an unknown page are the same not_found", async (t) => {
  const p = await pagesRig(t);
  const other = page(p.svc, "elsewhere", "q");
  p.svc.update(worker("w9", 1, "q"), { pageId: other.pageId, baseSeq: 1, title: "Plan", body: "agent text" });
  const runId = p.run("w1");
  const d = drive(p.r, runId, [[readPage(other.pageId), readPage("nope")], []]);
  await d.end;
  assert.deepEqual(d.results[1]?.map((x) => x.split(".")[0]), ["The call was refused (not_found)", "The call was refused (not_found)"], "the same answer for both");
  assert.equal(p.c.journal.composer.tainted(runId), false);
  assert.deepEqual(p.rows("message.taint"), []);
});

test("a denied write writes nothing; a change the card cannot show whole is refused before any card; a stale base is refused", async (t) => {
  const p = await pagesRig(t);
  const pg = page(p.svc);
  const denied = p.run("w1");
  const d1 = drive(p.r, denied, [[writePage({ pageId: pg.pageId, baseSeq: 1, title: "Plan", body: "changed" })], []]);
  assert.equal(await denyAll(p.r, d1.end), 1);
  await d1.end;
  assert.equal(p.svc.get({ pageId: pg.pageId }).version.meta.seq, 1, "nothing written");
  const big = p.run("w1");
  const d2 = drive(p.r, big, [[writePage({ pageId: pg.pageId, baseSeq: 1, title: "Plan", body: "z".repeat(3000) })], []]);
  assert.equal(await denyAll(p.r, d2.end), 0, "never put to the user");
  assert.match(d2.results[1]?.[0] ?? "", /^The call was refused \(content_not_reviewable\)\./);
  assert.deepEqual(d2.notes, []);
  const stale = p.run("w1");
  const d3 = drive(p.r, stale, [[writePage({ pageId: pg.pageId, baseSeq: 7, title: "Plan", body: "x" })], []]);
  await Promise.all([approveAll(p.r, d3.end), d3.end]);
  assert.match(d3.results[1]?.[0] ?? "", /^The call was refused \((stale_version|content_not_reviewable)\)\./);
  assert.equal(p.svc.get({ pageId: pg.pageId }).version.meta.seq, 1);
});

test("the page tools are offered only to a run with a worker", async (t) => {
  const p = await pagesRig(t);
  const without = p.run();
  const d = drive(p.r, without, [[readPage("anything")], []]);
  await d.end;
  assert.equal(d.tools[0]?.includes(READ_PAGE), false);
  assert.match(d.results[1]?.[0] ?? "", /unknown/);
  const withWorker = p.run("w1");
  const e = drive(p.r, withWorker, [[]]);
  await e.end;
  assert.ok(e.tools[0]?.includes(READ_PAGE) && e.tools[0]?.includes(WRITE_PAGE));
});

test("the change card's diff keeps only the lines that differ", () => {
  assert.equal(lineChange("a\nb\nc", "a\nB\nc"), "@@ line 2: -1 +1\n- b\n+ B");
  assert.equal(lineChange("a", "a\nb"), "@@ line 2: -0 +1\n+ b");
  assert.equal(lineChange("a\nb", "a"), "@@ line 2: -1 +0\n- b");
});
