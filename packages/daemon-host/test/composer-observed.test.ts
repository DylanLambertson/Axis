// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Review C2 r1: the base of a write is what the run saw (S2), files are keyed by what they are, not how they were spelled
// (S3), the Git directory is not re-read (N2), a lost change is surfaced (S1), and a non-UTF-8 read is refused (N6).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { RunEvent } from "@axis/protocol";
import type { MockReply, ValidRequest } from "@axis/providers";
import { ObservedFiles } from "../src/bindings/agent-observed.js";
import { DRIFT_OPEN } from "../src/composer/drift.js";
import { allEvents, composerRig, START, until, type ComposerRig, type ComposerRigOptions } from "./composer-rig.js";

const digest = (data: string | Buffer): string => `sha256:${createHash("sha256").update(data).digest("hex")}`;
const read = (path: string): MockReply => ({ kind: "tool_use", name: "read_file", input: { path } });
const write = (path: string, content: string, base?: string): MockReply => ({ kind: "tool_use", name: "write_file", input: { path, content, ...(base === undefined ? {} : { base }) } });
const say = (text: string): MockReply => ({ kind: "text", text });
const signal = new AbortController().signal;

async function setup(t: TestContext, options: ComposerRigOptions): Promise<ComposerRig> {
  const c = await composerRig(options);
  t.after(() => c.cleanup());
  return c;
}
const tools = (events: readonly RunEvent[]): string[] => events.flatMap((e) => (e.type === "tool" ? [`${e.tool}:${e.outcome}:${String(e.reason)}`] : []));
async function runToEnd(c: ComposerRig): Promise<string> {
  const { run } = await c.service.start(START(c.workspaceId), new AbortController().signal);
  await until(() => ["REVIEWING", "FAILED", "CANCELLED"].includes(c.service.get(run.runId).state) && !c.service.get(run.runId).live);
  return run.runId;
}
const noticeOf = (req: ValidRequest): string | undefined => {
  const last = req.messages[req.messages.length - 1];
  const blocks = (Array.isArray(last?.content) ? last.content : []) as { type: string; text?: string }[];
  return blocks.find((b) => b.type === "text" && b.text?.startsWith(DRIFT_OPEN) === true)?.text;
};

test("S2: a digest the run never saw replaces nothing, even when it matches (the empty file's well-known digest)", async (t) => {
  const c = await setup(t, { replies: [write("src/empty.txt", "replaced", digest("")), read("src/empty.txt"), write("src/empty.txt", "replaced", digest("")), say("done")] });
  writeFileSync(join(c.root, "src/empty.txt"), "");
  const runId = await runToEnd(c);
  assert.deepEqual(tools(allEvents(c, runId)), ["write_file:error:stale", "read_file:ok:null", "write_file:ok:null"]);
  assert.equal(readFileSync(join(c.root, "src/empty.txt"), "utf8"), "replaced", "after the run read it, the same base is accepted");
});

test("S3: a read through ./a.txt and a write to a.txt are one file: the run's own write is not drift, and the base binds", async (t) => {
  const seen: ValidRequest[] = [];
  const c = await setup(t, {
    replies: [read("./src//a.txt"), write("src/a.txt", "two", digest("one")), read("src/b.txt"), say("done")],
    onRequest: (_n, req) => void seen.push(req),
  });
  writeFileSync(join(c.root, "src/a.txt"), "one");
  writeFileSync(join(c.root, "src/b.txt"), "b");
  const runId = await runToEnd(c);
  assert.deepEqual(tools(allEvents(c, runId)), ["read_file:ok:null", "write_file:ok:null", "read_file:ok:null"]);
  assert.deepEqual(seen.map(noticeOf), [undefined, undefined, undefined, undefined]);
});

test("N6: a file that is not UTF-8 is refused, never handed back lossy", async (t) => {
  const c = await setup(t, { replies: [read("src/bin.dat"), say("done")] });
  writeFileSync(join(c.root, "src/bin.dat"), Buffer.from([0x61, 0xff, 0x62]));
  const runId = await runToEnd(c);
  assert.deepEqual(tools(allEvents(c, runId)), ["read_file:error:not_text"]);
});

function dir(t: TestContext): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "axis-observed-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("S1: a write that replaced someone's change is reported `lost` once; a drift report does not move the run's base", async (t) => {
  const root = dir(t);
  writeFileSync(join(root, "a.txt"), "one");
  const o = ObservedFiles.forRoot(root, "w1", 1024);
  const at = await o.locate("a.txt");
  assert.ok(at !== undefined);
  o.record("a.txt", at, digest("one"), { wrote: true, lost: true });
  assert.deepEqual(await o.drift(signal), [{ path: "a.txt", change: "lost" }]);
  assert.deepEqual(await o.drift(signal), []);
  writeFileSync(join(root, "a.txt"), "theirs");
  assert.deepEqual(await o.drift(signal), [{ path: "a.txt", change: "changed" }]);
  assert.equal(await o.seenBy("./a.txt"), digest("one"), "the model must read again: the base stays what the run saw");
});

test("N2: the Git directory is not re-read for drift", async (t) => {
  const root = dir(t);
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, ".git", "config"), "x");
  const o = ObservedFiles.forRoot(root, "w1", 1024);
  const at = await o.locate(".git/config");
  assert.ok(at !== undefined);
  o.record(".git/config", at, digest("x"), { wrote: false });
  writeFileSync(join(root, ".git", "config"), "y");
  assert.deepEqual(await o.drift(signal), [{ path: ".git/config", change: "unreadable" }]);
});
