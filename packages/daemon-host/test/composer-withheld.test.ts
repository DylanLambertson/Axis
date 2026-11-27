// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { ValidRequest } from "@axis/providers";
import { canary } from "../testing/git-fixture.js";
import { WITHHELD_NOTE } from "../src/composer/loop.js";
import { START, allEvents, composerRig, until } from "./composer-rig.js";

// A call that did not run is kept in the history without its input (review of the C7 slice, finding 3): content the broker or
// the user turned down is not sent again with every later request, while a call that ran keeps its input and the outgoing
// secret scan still refuses a request that holds a secret.

const write = (path: string, content: string) => ({ kind: "tool_use" as const, name: "write_file", input: { path, content } });
const TEXT = { kind: "text" as const, text: "understood" };

/** The provider requests the mock got, in order. */
function recorder(): { seen: ValidRequest[]; onRequest: (n: number, req: ValidRequest) => void } {
  const seen: ValidRequest[] = [];
  return { seen, onRequest: (_n, req) => void seen.push(structuredClone(req)) };
}

const toolUses = (req: ValidRequest | undefined) =>
  (req?.messages ?? []).flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b): b is Extract<typeof b, { type: "tool_use" }> => b.type === "tool_use");
const toolResults = (req: ValidRequest | undefined) =>
  (req?.messages ?? []).flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b): b is Extract<typeof b, { type: "tool_result" }> => b.type === "tool_result");

test("a protected write declined for the secret in its content does not end the run: its input is not sent again", async (t) => {
  const secret = canary(71);
  const rec = recorder();
  const c = await composerRig({ replies: [write(".envrc", `export TOKEN=${secret}\n`), TEXT], onRequest: rec.onRequest });
  t.after(() => c.cleanup());
  const { run } = await c.service.start(START(c.workspaceId), new AbortController().signal);
  await until(() => !c.service.get(run.runId).live);
  assert.deepEqual([c.service.get(run.runId).state, c.service.get(run.runId).reason], ["REVIEWING", null], "the run goes on (it ended PROVIDER_SECRET_IN_REQUEST before)");
  assert.equal(rec.seen.length, 2);
  const [use] = toolUses(rec.seen[1]);
  assert.deepEqual([use?.name, use?.input], ["write_file", {}], "the declined call keeps its id and name, not its input");
  const [res] = toolResults(rec.seen[1]);
  assert.equal(res?.toolUseId, use?.id);
  assert.ok(String(res?.content).includes("approval_declined") && String(res?.content).endsWith(WITHHELD_NOTE), String(res?.content));
  assert.ok(!JSON.stringify(rec.seen).includes(secret), "the secret went out with no request");
  assert.equal(existsSync(join(c.root, ".envrc")), false);
  assert.ok(!JSON.stringify(allEvents(c, run.runId)).includes(secret));
});

test("a refused call loses its input; a call that ran keeps it", async (t) => {
  const rec = recorder();
  const c = await composerRig({
    replies: [{ kind: "tool_use", name: "read_file", input: { path: "README.txt" } }, write("../outside.txt", "escape"), TEXT],
    onRequest: rec.onRequest,
  });
  t.after(() => c.cleanup());
  writeFileSync(join(c.root, "README.txt"), "hello\n");
  const { run } = await c.service.start(START(c.workspaceId), new AbortController().signal);
  await until(() => !c.service.get(run.runId).live);
  assert.equal(c.service.get(run.runId).state, "REVIEWING");
  assert.deepEqual(toolUses(rec.seen[2]).map((u) => [u.name, u.input]), [["read_file", { path: "README.txt" }], ["write_file", {}]]);
  assert.deepEqual(toolResults(rec.seen[2]).map((r) => String(r.content).endsWith(WITHHELD_NOTE)), [false, true]);
  assert.ok(String(toolResults(rec.seen[2])[0]?.content).includes("hello"), "what ran is what the model sees");
});

test("the outgoing scan is still fail-closed: a call that RAN with a secret in its input ends the run on the next request", async (t) => {
  const secret = canary(73);
  const rec = recorder();
  const c = await composerRig({ replies: [write("notes.txt", `key ${secret}\n`), TEXT], onRequest: rec.onRequest });
  t.after(() => c.cleanup());
  const { run } = await c.service.start(START(c.workspaceId), new AbortController().signal);
  await until(() => !c.service.get(run.runId).live);
  assert.deepEqual([c.service.get(run.runId).state, c.service.get(run.runId).reason], ["FAILED", "PROVIDER_SECRET_IN_REQUEST"]);
  assert.equal(readFileSync(join(c.root, "notes.txt"), "utf8"), `key ${secret}\n`, "the write below the approval floor ran");
  assert.equal(rec.seen.length, 1, "the request that would carry it never reached the provider");
});

test("ask mode: a tool call the mode cannot run loses its input too", async (t) => {
  const secret = canary(75);
  const rec = recorder();
  const c = await composerRig({ replies: [write("x.txt", secret), TEXT], onRequest: rec.onRequest });
  t.after(() => c.cleanup());
  const { run } = await c.service.start(START(c.workspaceId, { mode: "ask" }), new AbortController().signal);
  await until(() => !c.service.get(run.runId).live);
  assert.deepEqual([c.service.get(run.runId).state, rec.seen.length], ["REVIEWING", 2]);
  assert.deepEqual(toolUses(rec.seen[1]).map((u) => u.input), [{}]);
  assert.ok(!JSON.stringify(rec.seen[1]).includes(secret));
});
