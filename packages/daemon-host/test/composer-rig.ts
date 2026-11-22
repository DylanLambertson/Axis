// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog, Redactor, openDatabase, type DatabaseSync } from "@axis/audit";
import { Journal, type ActivityBounds } from "@axis/journal";
import type { RunEvent } from "@axis/protocol";
import type { MockProviderOptions, MockReply, RunBudgetLimits, ValidRequest } from "@axis/providers";
import type { Policy } from "@axis/daemon";
import { createProvidersBinding, type AnthropicConnectionOptions, type ProvidersBinding } from "../src/bindings/providers.js";
import { AGENT_PAYLOAD_ALLOWLIST, MESSAGES_PAYLOAD_ALLOWLIST, PAGES_PAYLOAD_ALLOWLIST, PROVIDERS_PAYLOAD_ALLOWLIST, TAINT_PAYLOAD_ALLOWLIST, createAgentBinding, createComposerService, type AgentBinding, type AgentBindingDeps, type ComposerService, type PreviewScanner, type ToolCaps } from "../src/index.js";
import { ProjectMutex } from "../src/worktrees/project-mutex.js";
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
  /** The one database handle (journal and audit log), for tests that reach a table directly. */
  readonly db: DatabaseSync;
  readonly service: ComposerService;
  readonly agent: AgentBinding;
  /** The network providers over the vault (C6); empty without `anthropic`. */
  readonly providers: ProvidersBinding;
  /** The one redactor of the rig: the providers register keys with it, the service redacts stored events with it. */
  readonly redactor: Redactor;
  /** The project mutex every composer write of the rig takes (the host's worktrees mutex). */
  readonly mutex: ProjectMutex;
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
  /** A database file instead of memory (restart tests reopen it); its directory is the caller's. */
  readonly dbPath?: string;
  readonly workspaceBudget?: RunBudgetLimits;
  readonly storedActivity?: ActivityBounds;
  /** Called with each provider request (its 1-based number) before the mock answers: an outside writer, or a look at what the model gets. */
  readonly onRequest?: (n: number, req: ValidRequest) => void;
  /** The broker's file system, built over the rig's directories (to inject a race inside a write). */
  readonly wrapFs?: (paths: { readonly root: string; readonly outside: string }) => NonNullable<AgentBindingDeps["wrapFs"]>;
  /** An Anthropic connection over the vault (C6), registered next to the mock. */
  readonly anthropic?: AnthropicConnectionOptions;
  /** A real worktree (a git fixture's linked worktree) instead of the rig's plain directory. */
  readonly worktree?: { readonly workTree: string; readonly gitDir: string };
  /** The host environment every tool child's PTY-2 environment is built from (built from the rig's directories). */
  readonly env?: (paths: { readonly root: string; readonly outside: string; readonly base: string }) => Readonly<Record<string, string | undefined>>;
  /** C3: the WT-2 guard (offers `run_command`) and the command bounds. */
  readonly commandGuard?: AgentBindingDeps["commandGuard"];
  readonly commandLimits?: AgentBindingDeps["commandLimits"];
  /** Broker tools without a preview schema (IAC-T tests of the taint source seam). */
  readonly extraTools?: AgentBindingDeps["extraTools"];
  /** The binding's test taint source (IAC-T): which successful calls taint the run. */
  readonly taintSources?: AgentBindingDeps["taintSources"];
  /** C3 slice 2: the host's git (offers `git_status` and `git_diff`). */
  readonly gitPath?: string;
  /** Messages delivered into runs at turn boundaries (PV-M3 slice 2). */
  readonly deliveries?: AgentBindingDeps["deliveries"];
  readonly messaging?: AgentBindingDeps["messaging"];
  /** PV-Q1 slice 2: `read_page` and `write_page` over a pages service. */
  readonly pages?: AgentBindingDeps["pages"];
}

const SHA = "b".repeat(40);

export async function composerRig(options: ComposerRigOptions): Promise<ComposerRig> {
  const r = await rig(options.policy === undefined ? {} : { policy: options.policy });
  const user = await r.connect();
  const base = realpathSync(mkdtempSync(join(tmpdir(), "axis-composer-")));
  const root = options.worktree?.workTree ?? join(base, "wt");
  const gitDir = options.worktree?.gitDir ?? join(root, ".git");
  const outside = join(base, "outside");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(outside);
  const db = openDatabase(options.dbPath ?? ":memory:");
  const audit = new AuditLog(db, { payloadAllowlist: { ...AGENT_PAYLOAD_ALLOWLIST, ...PROVIDERS_PAYLOAD_ALLOWLIST, ...TAINT_PAYLOAD_ALLOWLIST, ...MESSAGES_PAYLOAD_ALLOWLIST, ...PAGES_PAYLOAD_ALLOWLIST } });
  const journal = Journal.open(db, { audit });
  const ws = journal.createWorkspace({ projectId: "p", branch: "axis/x", baseRef: "main", baseSha: SHA, createdBy: "user" }).value;
  journal.transitionWorkspace(ws.id, "READY");
  const mutex = new ProjectMutex();
  let wire = 0;
  let tools = false;
  const replies = (options.script?.({ root, outside }) ?? options.replies).map((reply) => (req: ValidRequest): MockReply => {
    wire++;
    options.onRequest?.(wire, req);
    if ((req.tools?.length ?? 0) > 0) tools = true;
    return reply;
  });
  const redactor = new Redactor();
  const sink = { append: (e: Parameters<AuditLog["append"]>[0]) => (options.failAudit?.(e.action) === true ? ((): never => { throw new Error("disk full"); })() : audit.append(e)) };
  // A binding or service that refuses its options (a bound out of range, say) throws here, before the caller can register
  // `cleanup`: close what is already open, or the rig's server keeps the test file alive after the test has failed.
  let providers: ProvidersBinding;
  let agent: AgentBinding;
  let service: ComposerService;
  try {
    providers = createProvidersBinding({ redactor, audit: sink, ...(options.anthropic === undefined ? {} : { anthropic: options.anthropic }) });
    agent = createAgentBinding({
      // Every workspace of the journal shares the one directory (enough for the service's limits; containment uses its id).
      locator: { locate: async (id) => (journal.getWorkspace(id) !== undefined ? { workTree: root, gitDir } : Promise.reject(new Error("unknown"))) },
      repositoryRoots: () => [],
      audit: sink,
      redactor,
      providers: providers.providers,
      env: () => options.env?.({ root, outside, base }) ?? { PATH: "/usr/bin:/bin", HOME: base },
      approvals: r.approvals.runs,
      taintStore: journal.composer,
      now: () => r.clock.now(),
      mock: { ...options.mock, replies, respond: () => ({ kind: "text", text: "no more replies" }) },
      ...(options.previewScanner === undefined ? {} : { previewScanner: options.previewScanner }),
      writeLock: (_workspaceId, fn, signal) => mutex.exclusive("p", fn, signal),
      ...(options.wrapFs === undefined ? {} : { wrapFs: options.wrapFs({ root, outside }) }),
      ...(options.commandGuard === undefined ? {} : { commandGuard: options.commandGuard }),
      ...(options.commandLimits === undefined ? {} : { commandLimits: options.commandLimits }),
      ...(options.taintSources === undefined ? {} : { taintSources: options.taintSources }),
      ...(options.extraTools === undefined ? {} : { extraTools: options.extraTools }),
      ...(options.gitPath === undefined ? {} : { gitPath: options.gitPath }),
      ...(options.deliveries === undefined ? {} : { deliveries: options.deliveries }),
      ...(options.messaging === undefined ? {} : { messaging: options.messaging }),
      ...(options.pages === undefined ? {} : { pages: options.pages }),
    });
    service = createComposerService({
      redactor,
      journal,
      engine: agent,
      now: () => r.clock.now(),
      ...(options.budget === undefined ? {} : { budget: options.budget }),
      ...(options.workspaceBudget === undefined ? {} : { workspaceBudget: options.workspaceBudget }),
      ...(options.storedActivity === undefined ? {} : { storedActivity: options.storedActivity }),
      ...(options.maxActive === undefined ? {} : { maxActive: options.maxActive }),
      ...(options.toolCaps === undefined ? {} : { toolCaps: options.toolCaps }),
    });
  } catch (e) {
    await r.cleanup();
    db.close();
    rmSync(base, { recursive: true, force: true });
    throw e;
  }
  return {
    r,
    user,
    journal,
    audit,
    db,
    service,
    agent,
    providers,
    redactor,
    mutex,
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

/** A hang guard only (a stuck run fails the test instead of hanging CI); a run that is making progress never reaches it, however loaded the host. */
const HANG_GUARD_MS = 120_000;

/**
 * Wait until `pred` holds. A run does real file system and timer work, whose completion on a loaded host is not a count of event
 * loop turns, so the wait is by condition: it yields to the event loop between tries and gives up only at the hang guard.
 */
export async function until(pred: () => boolean, what = "the condition", guardMs = HANG_GUARD_MS): Promise<void> {
  const deadline = process.hrtime.bigint() + BigInt(guardMs) * 1_000_000n;
  for (let turn = 0; ; turn++) {
    if (pred()) return;
    if (process.hrtime.bigint() > deadline) throw new Error(`condition not reached: ${what}`);
    await new Promise((res) => (turn % 64 === 63 ? setTimeout(res, 1) : setImmediate(res)));
  }
}
