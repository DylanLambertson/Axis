// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog, Redactor, openDatabase } from "@axis/audit";
import { Journal } from "@axis/journal";
import type { RunEvent } from "@axis/protocol";
import type { MockProviderOptions, MockReply, RunBudgetLimits } from "@axis/providers";
import type { Policy } from "@axis/daemon";
import { AGENT_PAYLOAD_ALLOWLIST, createAgentBinding, createComposerService, type AgentBinding, type ComposerService, type PreviewScanner, type ToolCaps } from "../src/index.js";
import { rig, type Client, type Rig } from "./approvals-rig.js";

/**
 * A composer service over the REAL pieces: an in-memory journal and audit log, the agent binding with the real
 * `ToolBroker` and the guarded mock provider, and `createApprovals` (through `approvals-rig`, which serves the real
 * `axis.approvals/1` handlers to a user connection). The workspace's worktree is a temporary directory; the locator
 * points at it the way the host's locator would (by workspace id, never a payload).
 */
export interface ComposerRig {
  readonly r: Rig;
  readonly user: Client;
  readonly journal: Journal;
  readonly audit: AuditLog;
  readonly service: ComposerService;
  readonly agent: AgentBinding;
  readonly workspaceId: string;
  /** The worktree root (real path). */
  readonly root: string;
  /** A directory next to the worktree, outside it. */
  readonly outside: string;
  /** Provider requests that reached the mock's simulated wire. */
  readonly wire: () => number;
  /** The mock request that carried tools, if any. */
  readonly sawTools: () => boolean;
  cleanup(): Promise<void>;
}

export interface ComposerRigOptions {
  readonly replies: ReadonlyArray<MockReply>;
  /** Replies built from the rig's own directories (used instead of `replies` when given). */
  readonly script?: (paths: { readonly root: string; readonly outside: string }) => ReadonlyArray<MockReply>;
  readonly budget?: RunBudgetLimits;
  readonly mock?: Partial<MockProviderOptions>;
  /** Replace the rig's rule-table policy (to control trust). */
  readonly policy?: Policy;
  /** The agent binding's audit sink throws for these rows (the journal's own log is unaffected). */
  readonly failAudit?: (action: string) => boolean;
  readonly maxActive?: number;
  readonly toolCaps?: Partial<ToolCaps>;
  readonly previewScanner?: PreviewScanner;
}

const SHA = "b".repeat(40);

export async function composerRig(options: ComposerRigOptions): Promise<ComposerRig> {
  const r = await rig(options.policy === undefined ? {} : { policy: options.policy });
  const user = await r.connect();
  const base = realpathSync(mkdtempSync(join(tmpdir(), "axis-composer-")));
  const root = join(base, "wt");
  const outside = join(base, "outside");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(outside);
  const db = openDatabase(":memory:");
  const audit = new AuditLog(db, { payloadAllowlist: AGENT_PAYLOAD_ALLOWLIST });
  const journal = Journal.open(db, { audit });
  const ws = journal.createWorkspace({ projectId: "p", branch: "axis/x", baseRef: "main", baseSha: SHA, createdBy: "user" }).value;
  journal.transitionWorkspace(ws.id, "READY");
  let wire = 0;
  let tools = false;
  const replies = (options.script?.({ root, outside }) ?? options.replies).map((reply) => (req: { readonly tools?: readonly unknown[] | undefined }): MockReply => {
    wire++;
    if ((req.tools?.length ?? 0) > 0) tools = true;
    return reply;
  });
  const agent = createAgentBinding({
    // Every workspace of the journal shares the one directory (enough for the service's limits; containment uses its id).
    locator: { locate: async (id) => (journal.getWorkspace(id) !== undefined ? { workTree: root, gitDir: join(root, ".git") } : Promise.reject(new Error("unknown"))) },
    repositoryRoots: () => [],
    audit: { append: (e) => (options.failAudit?.(e.action) === true ? ((): never => { throw new Error("disk full"); })() : audit.append(e)) },
    redactor: new Redactor(),
    env: () => ({ PATH: "/usr/bin:/bin", HOME: base }),
    approvals: r.approvals.runs,
    now: () => r.clock.now(),
    mock: { ...options.mock, replies, respond: () => ({ kind: "text", text: "no more replies" }) },
    ...(options.previewScanner === undefined ? {} : { previewScanner: options.previewScanner }),
  });
  const service = createComposerService({
    journal,
    engine: agent,
    now: () => r.clock.now(),
    ...(options.budget === undefined ? {} : { budget: options.budget }),
    ...(options.maxActive === undefined ? {} : { maxActive: options.maxActive }),
    ...(options.toolCaps === undefined ? {} : { toolCaps: options.toolCaps }),
  });
  return {
    r,
    user,
    journal,
    audit,
    service,
    agent,
    workspaceId: ws.id,
    root,
    outside,
    wire: () => wire,
    sawTools: () => tools,
    async cleanup() {
      service.dispose();
      agent.dispose();
      await service.idle();
      await r.cleanup();
      db.close();
      rmSync(base, { recursive: true, force: true });
    },
  };
}

export const START = (workspaceId: string, over: Record<string, unknown> = {}) => ({
  workspaceId,
  mode: "edit" as const,
  prompt: "Make the change",
  providerId: "mock",
  modelId: "mock-model",
  windowId: "win-1",
  ...over,
});

/** Every event of a run so far. */
export function allEvents(c: ComposerRig, runId: string): RunEvent[] {
  return c.service.events(runId, 0, 200).events;
}

/** Wait (event loop turns, never wall-clock bounds) until `pred` holds. */
export async function until(pred: () => boolean, turns = 2000): Promise<void> {
  for (let i = 0; i < turns; i++) {
    if (pred()) return;
    await new Promise((res) => setImmediate(res));
  }
  throw new Error("condition not reached");
}
