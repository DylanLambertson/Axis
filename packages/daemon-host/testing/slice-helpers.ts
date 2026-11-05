// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { chmodSync, cpSync, readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ChainHead } from "@axis/audit";
import { MAX_AUDIT_LIST } from "@axis/protocol";
import type { GitFixture } from "./git-fixture.js";
import { TestSupervisor, type TestSupervisorOptions } from "./test-supervisor.js";
import { TestClient, newKey, until } from "./test-client.js";

/** Entry points compiled next to this file (`dist/testing`). They are scripts: importing them would run them. */
export const SLICE_HOST = fileURLToPath(new URL("./slice-host.js", import.meta.url));
export const FAKE_CLI = fileURLToPath(new URL("./fake-cli.js", import.meta.url));

/** Names the host child inherits that the PTY-5 environment must remove before a CLI sees them (values are inert placeholders). */
export const DENIED_SEEDS = ["VSCODE_NONCE", "ELECTRON_RUN_AS_NODE", "GIT_ASKPASS", "GIT_EDITOR"] as const;

const started: TestSupervisor[] = [];

/** Kill every host this file started (last first), also after a failed step, so a test never leaves a child or its pipes behind. */
export async function disposeHosts(): Promise<void> {
  for (const sup of started.splice(0).reverse()) await sup.dispose();
}

export interface SliceHost {
  readonly sup: TestSupervisor;
  /** Wait for the host's `ready`. */
  readonly ready: Promise<Record<string, unknown>>;
}

/** Start the composed host as a child process on `fx`'s environment. `agents` is what `axis.cliAgents` answers. */
export async function startHost(fx: GitFixture, over: Partial<TestSupervisorOptions> & { scanMode?: "refuse" | "warn"; agents?: unknown; probeMutex?: boolean; breakPutFile?: string } = {}): Promise<SliceHost> {
  const { scanMode, agents, probeMutex, breakPutFile, ...rest } = over;
  // The host's git environment is checked by git-ops: the pty one must not set GIT_CONFIG_NOSYSTEM (the fixture's own git calls do).
  const { GIT_CONFIG_NOSYSTEM: _fixtureOnly, ...hostBase } = fx.env;
  const env: Record<string, string> = { ...hostBase, AXIS_SLICE_SCAN_MODE: scanMode ?? "refuse" };
  if (breakPutFile !== undefined) env["AXIS_SLICE_BREAK_PUT"] = breakPutFile;
  if (probeMutex === true) env["AXIS_SLICE_MUTEX_PROBE"] = "1";
  for (const n of DENIED_SEEDS) env[n] = "placeholder";
  const sup = await TestSupervisor.start({ entry: SLICE_HOST, env, ...rest });
  started.push(sup);
  sup.settings["axis.cliAgents"] = agents ?? [];
  const ready = sup.waitFor("ready") as unknown as Promise<Record<string, unknown>>;
  ready.catch(() => undefined); // a host that is meant to exit (a lock conflict) is not an unhandled rejection; awaiters still see it
  return { sup, ready };
}

/** `projects.register` through the supervisor, as main would; resolves the project id. */
export async function registerProject(sup: TestSupervisor, path: string): Promise<string> {
  const requestId = `reg-${newKey().slice(0, 8)}`;
  const from = sup.received.length;
  sup.mux.sendControl({ type: "projects.register", requestId, path, trusted: true });
  const reply = await sup.waitFor("projects.result", from);
  if (!reply.ok) throw new Error(`projects.register refused: ${reply.code}`);
  return reply.projectId;
}

/** The supervisor says window `win-1` is trusted, as main does after Workspace Trust. */
export function trustWindow(sup: TestSupervisor): void {
  sup.mux.sendControl({ type: "trust.set", windowId: "win-1", trusted: true });
}

export interface Workspace {
  readonly id: string;
  readonly path: string;
  readonly branch: string;
  readonly baseSha: string;
}

export async function createWorkspace(client: TestClient, projectId: string, name: string): Promise<Workspace> {
  const created = await client.ok<{ id: string }>("axis.worktrees", "create", { projectId, name }, true);
  return describeWorkspace(client, created.id);
}

export async function describeWorkspace(client: TestClient, id: string): Promise<Workspace> {
  const { worktrees } = await client.ok<{ worktrees: Array<{ path: string; branch: string | null; baseSha?: string }> }>("axis.worktrees", "status", { ids: [id] });
  const w = worktrees[0];
  if (w === undefined || w.branch === null || w.baseSha === undefined) throw new Error("the workspace is not described");
  return { id, path: w.path, branch: w.branch, baseSha: w.baseSha };
}

/** Poll a run until its state is `state` (or fail on a state it cannot leave). */
export async function awaitRun(client: TestClient, runId: string, state: string, seen: Set<string> = new Set()): Promise<Record<string, unknown>> {
  let run: Record<string, unknown> = {};
  await until(async () => {
    run = (await client.ok<{ run: Record<string, unknown> }>("axis.cli-runs", "get", { runId })).run;
    seen.add(String(run["state"]));
    return run["state"] === state;
  }, `run ${state}`);
  return run;
}

/** A read-only view of a stopped host's database (copy first: a host that is gone leaves WAL files a read-only open may not like). */
export function openStopped(dataDir: string, into: string): DatabaseSync {
  cpSync(dataDir, into, { recursive: true });
  return new DatabaseSync(join(into, "axis.db"), { readOnly: true });
}

export interface AuditRow {
  readonly seq: number;
  readonly actor: string;
  readonly action: string;
  readonly target: string;
  readonly outcome: string;
  readonly payload: string;
}

export const auditRows = (db: DatabaseSync): AuditRow[] => db.prepare("SELECT seq, actor, action, target, outcome, payload FROM audit_events ORDER BY seq").all() as unknown as AuditRow[];

/** The bytes of every file of the database (main and WAL), for the "appears nowhere" checks. */
export function databaseBytes(dir: string): Buffer {
  const files = readdirSync(dir).filter((f) => f.startsWith("axis.db"));
  return Buffer.concat(files.map((f) => readFileSync(join(dir, f))));
}

export const head = (h: ChainHead | null): string => (h === null ? "none" : `${h.seq}:${h.hash.slice(0, 8)}`);

/**
 * A copy of a stopped host's data directory that the test may damage (an attacker with file access): the same owner, mode 0700, and
 * the append-only triggers of the audit log dropped when `unlock` is set. Returns the directory.
 */
export function damagedCopy(dataDir: string, into: string, damage: (db: DatabaseSync) => void): string {
  cpSync(dataDir, into, { recursive: true });
  if (process.platform !== "win32") chmodSync(into, 0o700);
  const db = new DatabaseSync(join(into, "axis.db"));
  try {
    db.exec("DROP TRIGGER audit_events_no_update; DROP TRIGGER audit_events_no_delete");
    damage(db);
  } finally {
    db.close();
  }
  return into;
}

/**
 * The user's native confirmation of a challenge, answered through the supervisor, and the wait until the host has RECORDED it (the
 * audit log says so): after this the approved retry is accepted at once, so a test never polls an approval it could spend.
 */
export async function confirmNative(sup: TestSupervisor, client: TestClient, challengeId: string): Promise<void> {
  const confirmed = async (): Promise<number> => {
    const { head } = await client.ok<{ head: { seq: number } | null }>("axis.audit", "status", {});
    const { events } = await client.ok<{ events: Array<{ action: string; payload: Record<string, unknown> }> }>("axis.audit", "list", { afterSeq: Math.max(0, (head?.seq ?? 0) - MAX_AUDIT_LIST), limit: MAX_AUDIT_LIST });
    return events.filter((e) => e.action === "tier4.challenge" && e.payload["phase"] === "native" && e.payload["decision"] === "confirm").length;
  };
  const before = await confirmed();
  sup.answerNative(challengeId, true);
  await until(async () => (await confirmed()) > before, "the native confirmation to be recorded");
}
