// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Review C2 r2: the binding's handling of a lost change end to end (N3), the truth about a `swapped` write (N2), and name
// folding on a case-insensitive platform through an injected platform (N5).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { RunEvent } from "@axis/protocol";
import type { MockReply, ValidRequest } from "@axis/providers";
import { SWAPPED_RESULT } from "../src/bindings/agent.js";
import { ObservedFiles } from "../src/bindings/agent-observed.js";
import { DRIFT_OPEN } from "../src/composer/drift.js";
import { allEvents, composerRig, START, until, type ComposerRig, type ComposerRigOptions } from "./composer-rig.js";

const digest = (data: string): string => `sha256:${createHash("sha256").update(data).digest("hex")}`;
const read = (path: string): MockReply => ({ kind: "tool_use", name: "read_file", input: { path } });
const write = (path: string, content: string, base?: string): MockReply => ({ kind: "tool_use", name: "write_file", input: { path, content, ...(base === undefined ? {} : { base }) } });
const say = (text: string): MockReply => ({ kind: "text", text });
const skipLinks = process.platform === "win32" ? "symlinks need privileges on Windows" : false;

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
function lastBlocks(req: ValidRequest): { type: string; text?: string; content?: unknown }[] {
  const last = req.messages[req.messages.length - 1];
  return (Array.isArray(last?.content) ? last.content : []) as { type: string; text?: string; content?: unknown }[];
}
const noticeOf = (req: ValidRequest): string | undefined => lastBlocks(req).find((b) => b.type === "text" && b.text?.startsWith(DRIFT_OPEN) === true)?.text;
const resultsOf = (req: ValidRequest): string[] => lastBlocks(req).flatMap((b) => (b.type === "tool_result" ? [String(b.content)] : []));

/** A rig whose broker runs `beforeRename(to)` once, just before the swap's `rename` of the target (the residual window). */
function racingRig(target: string, beforeRename: (paths: { root: string; outside: string }) => void, replies: MockReply[], seen: ValidRequest[]): ComposerRigOptions {
  return {
    replies,
    onRequest: (_n, req) => void seen.push(req),
    wrapFs: (paths) => (real) => {
      let fired = false;
      return {
        ...real,
        async rename(from, to) {
          if (!fired && to === join(paths.root, target)) {
            fired = true;
            beforeRename(paths);
          }
          return (real.rename as NonNullable<typeof real.rename>)(from, to);
        },
      };
    },
  };
}

test("N3: a change made in place in the residual window is told in the tool result and listed `lost` in the next notice", async (t) => {
  const seen: ValidRequest[] = [];
  const c = await setup(
    t,
    racingRig("src/a.txt", ({ root }) => writeFileSync(join(root, "src/a.txt"), "late change"), [read("src/a.txt"), write("src/a.txt", "ours", digest("base")), read("src/b.txt"), say("done")], seen),
  );
  writeFileSync(join(c.root, "src/a.txt"), "base");
  writeFileSync(join(c.root, "src/b.txt"), "b");
  const runId = await runToEnd(c);
  assert.deepEqual(tools(allEvents(c, runId)), ["read_file:ok:null", "write_file:ok:null", "read_file:ok:null"]);
  assert.equal(readFileSync(join(c.root, "src/a.txt"), "utf8"), "ours");
  const result = resultsOf(seen[2] as ValidRequest)[0] ?? "";
  assert.match(result, /^wrote 4 bytes\ndigest: sha256:[0-9a-f]{64}\nWarning: the file was changed by someone else while it was being replaced; that change was overwritten\.$/);
  const notice = noticeOf(seen[2] as ValidRequest);
  assert.ok(notice?.includes('lost: "src/a.txt"') === true && !notice.includes('changed: "src/a.txt"'), String(notice));
  assert.equal(noticeOf(seen[3] as ValidRequest), undefined, "reported once");
});

test("N3: a clean write carries no warning and no `lost` entry", async (t) => {
  const seen: ValidRequest[] = [];
  const c = await setup(t, racingRig("src/a.txt", () => undefined, [read("src/a.txt"), write("src/a.txt", "ours", digest("base")), say("done")], seen));
  writeFileSync(join(c.root, "src/a.txt"), "base");
  await runToEnd(c);
  assert.deepEqual(resultsOf(seen[2] as ValidRequest), [`wrote 4 bytes\ndigest: ${digest("ours")}`]);
  assert.equal(noticeOf(seen[2] as ValidRequest), undefined);
});

test("N2: a folder swapped for a symlink in the residual window is not reported as a plain refusal: the write may be outside", { skip: skipLinks }, async (t) => {
  const seen: ValidRequest[] = [];
  const swap = ({ root, outside }: { root: string; outside: string }): void => {
    renameSync(join(root, "src/sub"), join(outside, "sub"));
    symlinkSync(join(outside, "sub"), join(root, "src/sub"));
  };
  const c = await setup(t, racingRig("src/sub/a.txt", swap, [read("src/sub/a.txt"), write("src/sub/a.txt", "ours", digest("base")), say("done")], seen));
  mkdirSync(join(c.root, "src/sub"));
  writeFileSync(join(c.root, "src/sub/a.txt"), "base");
  const runId = await runToEnd(c);
  assert.deepEqual(tools(allEvents(c, runId)), ["read_file:ok:null", "write_file:error:swapped"]);
  assert.equal(readFileSync(join(c.outside, "sub/a.txt"), "utf8"), "ours", "the bytes did land outside: the result must not say refused");
  const result = resultsOf(seen[2] as ValidRequest)[0] ?? "";
  assert.equal(result, SWAPPED_RESULT);
  assert.doesNotMatch(result, /refused/);
  assert.match(result, /may have landed outside the workspace/);
});

function dir(t: TestContext): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "axis-observed-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

// win32 folds through the same branch as darwin (`caseInsensitive` in the broker), but a POSIX root cannot be resolved
// with win32 path rules, so the injected platform here is darwin.
test("N5: on macOS a name differing only in case or Unicode normalisation is one file; on Linux it is two", async (t) => {
  const root = dir(t);
  const nfc = "é.txt";
  const nfd = "é.txt";
  for (const platform of ["darwin", "linux"] as const) {
    const o = ObservedFiles.forRoot(root, "w1", 1024, platform);
    const upper = await o.locate("A.txt");
    const lower = await o.locate("a.txt");
    const composed = await o.locate(nfc);
    const decomposed = await o.locate(nfd);
    assert.ok(upper !== undefined && lower !== undefined && composed !== undefined && decomposed !== undefined, platform);
    const folds = platform !== "linux";
    assert.equal(upper.key === lower.key, folds, `${platform}: case`);
    assert.equal(composed.key === decomposed.key, folds, `${platform}: NFC/NFD`);
    o.record("A.txt", upper, digest("x"), { wrote: false });
    assert.equal(await o.seenBy("a.txt"), folds ? digest("x") : undefined, `${platform}: the base binds across spellings`);
  }
});
