// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunEvent } from "@axis/protocol";
import type { AnthropicConnectionOptions } from "../src/bindings/providers.js";
import { fakeBackend, mockAnthropic, MODEL, testKey, type FakeBackend, type MessagesReply, type MockAnthropic } from "./anthropic-server.js";
import { allEvents, composerRig, START, type ComposerRig } from "./composer-rig.js";

/** A composer rig with an Anthropic connection over a fake vault backend and the local mock server (ticket C6 tests). */
export const CONN = "anthropic-main";
export const ANT = { providerId: "anthropic", modelId: MODEL };

export interface Setup {
  readonly c: ComposerRig;
  readonly api: MockAnthropic;
  readonly backend: FakeBackend;
  readonly key: string;
  readonly dir: string;
  /** Every byte of the rig's database (journal and audit), its WAL included. */
  readonly dbText: () => string;
  done(): Promise<void>;
}

export async function setup(replies: MessagesReply[], over: Partial<AnthropicConnectionOptions> = {}, backend?: FakeBackend, key = testKey()): Promise<Setup> {
  const api = await mockAnthropic();
  api.replies = replies;
  const store = backend ?? fakeBackend(CONN, key);
  const dir = mkdtempSync(join(tmpdir(), "axis-c6-"));
  const dbPath = join(dir, "host.db");
  const c = await composerRig({ replies: [], dbPath, anthropic: { connectionId: CONN, backend: store, fetch: api.fetch, ...over } });
  const dbText = (): string => [dbPath, `${dbPath}-wal`].filter((p) => existsSync(p)).map((p) => readFileSync(p).toString("latin1")).join("\n");
  return {
    c,
    api,
    backend: store,
    key,
    dir,
    dbText,
    async done() {
      await c.cleanup();
      await api.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Wait for the run to leave RUNNING (real sockets: bounded event-loop waits, never a timing assertion). */
export async function ended(c: ComposerRig, runId: string): Promise<ReturnType<ComposerRig["service"]["get"]>> {
  for (let i = 0; i < 10_000; i++) {
    const run = c.service.get(runId);
    if (run.state !== "RUNNING" && run.state !== "QUEUED") return run;
    await new Promise((res) => setTimeout(res, 2));
  }
  throw new Error("the run did not end");
}

export async function runOnce(s: Setup, prompt = "Say hello"): Promise<{ run: Awaited<ReturnType<typeof ended>>; events: RunEvent[] }> {
  const { run } = await s.c.service.start(START(s.c.workspaceId, { ...ANT, prompt, mode: "ask" }), new AbortController().signal);
  const done = await ended(s.c, run.runId);
  return { run: done, events: allEvents(s.c, run.runId) };
}

/** Nowhere the host keeps or shows anything: the live events, the run, the journal and audit rows (raw database bytes). */
export function assertNoKey(s: Setup, ...shown: unknown[]): void {
  for (const value of shown) assert.ok(!JSON.stringify(value).includes(s.key), "the key is in an answer or an event");
  assert.ok(!s.dbText().includes(s.key), "the key is in the database (journal or audit)");
  assert.ok(!s.dbText().includes(s.key.slice(8)), "a part of the key is in the database");
}

export const credentialRows = (c: ComposerRig) => c.audit.list({ limit: 500 }).filter((e) => e.action === "provider.credential");
