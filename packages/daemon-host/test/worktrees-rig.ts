// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { Redactor, withTransaction } from "@axis/audit";
import { Daemon, protocolRegistry, type Identity, type IdentityVerifier, type DaemonAuditEvent } from "@axis/daemon";
import { Journal, JournalIdempotencyStore } from "@axis/journal";
import {
  ChannelMux,
  ControlClient,
  InMemoryTrustRegistry,
  RULES,
  RuleTablePolicy,
  createApprovalsHandlers,
  createChallengeAuditLog,
  createChallengeAuditSink,
  createWorktreesApprovals,
  createWorktreesHandlers,
  resolveGitOnce,
  type Approvals,
  type ManagerShape,
  type WorktreesBinding,
} from "../src/index.js";
import { createWorktreesBindingForTest, type WorktreesTestSeams } from "../src/bindings/worktrees.js";
import { memoryChannelPair } from "../testing/memory-channel.js";
import { memoryPair } from "@axis/daemon";
import { Client, newKey, type Msg } from "./approvals-rig.js";
import { fakeClock } from "./helpers.js";

/** Git, with no host config and a fixed identity; the working directory is where the command runs. */
export function git(cwd: string, home: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    env: { PATH: process.env["PATH"] ?? "", HOME: home, GIT_CONFIG_NOSYSTEM: "1" },
  });
}

/** Skip reason when git is missing or cannot do what the fixtures need; `undefined` when the suite can run. */
export function gitSkipReason(): string | undefined {
  try {
    execFileSync("git", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return undefined;
  } catch {
    return "git is not available";
  }
}

export interface Rig {
  readonly tmp: string;
  readonly repo: string;
  readonly root: string;
  readonly db: DatabaseSync;
  readonly journal: Journal;
  readonly binding: WorktreesBinding;
  /** The manager shape the service uses (for tests that call `reconcileWorktrees` directly). */
  readonly manager: ManagerShape;
  readonly approvals: Approvals;
  readonly daemon: Daemon;
  readonly rpcEvents: DaemonAuditEvent[];
  readonly supervisor: Array<Record<string, unknown>>;
  readonly active: Set<string>;
  /** Answers for the next `hasActiveRun` calls, in order, before falling back to `active` (a call that sees a run only later). */
  readonly script: boolean[];
  readonly trust: InMemoryTrustRegistry;
  readonly home: string;
  readonly gitPath: string;
  readonly gitLog: string;
  readonly projectId: string;
  git(cwd: string, ...args: string[]): string;
  connect(attestation?: string): Promise<Client>;
  nativeConfirms(): Array<Record<string, unknown>>;
  answer(challengeId: string, proof: string, confirmed: boolean): void;
  cleanup(): Promise<void>;
}

const verifier: IdentityVerifier = {
  verify(att) {
    if (typeof att !== "string") return undefined;
    const [actor, conn, windowId] = att.split("#");
    return {
      connectionId: (conn as string).padEnd(22, "_"),
      windowId: windowId as string,
      actorId: `${actor}-id`,
      actor: actor as Identity["actor"],
      trusted: true,
      clientKind: "desktop",
    };
  },
};

export interface RigOptions {
  /** Called after the repository is committed and before the project is registered. */
  prepare?: (repo: string, home: string) => void;
  /** Make the binding think a run is active (workspace ids). */
  preflight?: (tier: number) => void;
  /** Run git through a logging wrapper at the pinned path, with no git on PATH (posix only). */
  gitWrapper?: boolean;
  /** Fixed bytes for the slug suffix (`010203`), so a test can predict a branch name. */
  fixedSuffix?: boolean;
  /** Make the binding's audit appends fail for matching events (the journal's own audit is unaffected). */
  testSeams?: WorktreesTestSeams;
  failAudit?: (e: { action: string; payload?: unknown }) => boolean;
}

export async function worktreesRig(options: RigOptions = {}): Promise<Rig> {
  const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "axis-h8-")));
  const repo = path.join(tmp, "repo");
  const root = path.join(tmp, "wt-root");
  const home = path.join(tmp, "home");
  for (const d of [repo, root, home]) mkdirSync(d);
  const g = (cwd: string, ...args: string[]): string => git(cwd, home, ...args);
  g(repo, "init", "-q");
  // The initial branch is read from git, never assumed: the fixture names it itself (no `-b`, no version assumption).
  g(repo, "symbolic-ref", "HEAD", "refs/heads/main");
  writeFileSync(path.join(repo, "a.txt"), "alpha\n");
  mkdirSync(path.join(repo, "sub"));
  writeFileSync(path.join(repo, "sub", "b.txt"), "bravo\n");
  writeFileSync(path.join(repo, ".gitignore"), "ignored.log\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "init");
  options.prepare?.(repo, home);

  const db = new DatabaseSync(":memory:");
  const clock = fakeClock();
  const redactor = new Redactor();
  const audit = createChallengeAuditLog(db, { redactor, now: () => new Date(clock.now()) });
  const journal = Journal.open(db, { audit, now: () => new Date(clock.now()) });
  const idempotency = JournalIdempotencyStore.open(db, { audit, redactor, monotonic: () => clock.monotonic() });
  const projectId = "proj-1";
  journal.registerProject({ id: projectId, path: repo, displayName: "fixture", trusted: true, actor: "user" });

  let env: Record<string, string> = { PATH: process.env["PATH"] ?? "", HOME: home };
  let gitPath = resolveGitOnce({ env, platform: process.platform, excludeDirs: [root, tmp, repo] });
  const gitLog = path.join(tmp, "git.log");
  if (options.gitWrapper === true) {
    const bin = path.join(tmp, "bin");
    mkdirSync(bin);
    const wrapper = path.join(bin, "git");
    writeFileSync(wrapper, `#!/bin/sh\necho x >> "${gitLog}"\nexec "${gitPath}" "$@"\n`, { mode: 0o755 });
    gitPath = wrapper;
    env = { PATH: home, HOME: home }; // an empty directory: any lookup of a bare `git` would fail
  }
  const active = new Set<string>();
  const script: boolean[] = [];
  const { a, b } = memoryChannelPair();
  const mux = new ChannelMux(a);
  const control = new ControlClient({ mux });
  const supervisor: Array<Record<string, unknown>> = [];
  b.onMessage((m) => supervisor.push(m as Record<string, unknown>));
  const approvals = createWorktreesApprovals({
    audit: createChallengeAuditSink(audit),
    control,
    clock,
    ...(options.preflight === undefined ? {} : { preflight: options.preflight }),
  });
  let manager: ManagerShape | undefined;
  const binding = createWorktreesBindingForTest({
    journal,
    audit: { append: (e) => (options.failAudit?.(e) === true ? ((): never => { throw new Error("audit down"); })() : audit.append(e)) },
    transact: (fn) => withTransaction(db, fn),
    random: { bytes: (n) => (options.fixedSuffix === true ? Uint8Array.from({ length: n }, (_, i) => i + 1) : randomBytes(n)), uuid: () => randomUUID() },
    runs: { hasActiveRun: (id) => (script.length > 0 ? (script.shift() as boolean) : active.has(id)) },
    gitPath,
    env,
    platform: process.platform,
    worktreeRoot: root,
    onPreview: approvals.onPreview,
  }, {
    ...options.testSeams,
    wrapManager: (m) => {
      manager = options.testSeams?.wrapManager?.(m) ?? m;
      return manager;
    },
  });

  const trust = new InMemoryTrustRegistry();
  trust.set({ windowId: "win-1" }, true);
  const rpcEvents: DaemonAuditEvent[] = [];
  const daemon = new Daemon({
    identity: verifier,
    audit: { append: (e) => void rpcEvents.push(e) },
    registry: protocolRegistry,
    idempotency,
    policy: new RuleTablePolicy(trust, RULES),
    approvals: approvals.gate,
  });
  daemon.register("axis.approvals", 1, createApprovalsHandlers({ approvals: approvals.port }));
  daemon.register("axis.worktrees", 1, createWorktreesHandlers({ service: binding.service, needsAttention: binding.needsAttention }), {
    content: binding.content,
  });
  const ports: Array<{ close(): void }> = [];
  return {
    tmp, repo, root, db, journal, binding, manager: manager as ManagerShape, approvals, daemon, rpcEvents, supervisor, active, script, trust, home, gitPath, gitLog, projectId,
    git: g,
    async connect(attestation = "user#conn-1#win-1") {
      const { client, server } = memoryPair();
      ports.push(client);
      const c = new Client(client);
      daemon.accept(server, attestation);
      await c.hello();
      return c;
    },
    nativeConfirms: () => supervisor.filter((m) => m["type"] === "native.confirm"),
    answer: (challengeId, proof, confirmed) => b.send({ type: "native.result", challengeId, proof, confirmed, windowId: "win-1" }),
    async cleanup() {
      approvals.dispose();
      control.dispose();
      mux.dispose();
      daemon.stop();
      for (const p of ports) p.close();
      b.close();
      db.close();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

/** Create a workspace through the daemon as `user`; `check` asserts the answer (for example against the contract schema). */
export async function createWs(
  user: Client,
  check: (method: "create", m: Msg) => Msg,
  name = "Fix the parser",
  over: Record<string, unknown> = {},
  key = newKey(),
): Promise<{ id: string; msg: Msg }> {
  const msg = check("create", await user.call("axis.worktrees", "create", { projectId: "proj-1", name, ...over }, key));
  return { id: (msg.result as { id: string }).id, msg };
}

/** A finished run of `id` with its run base ref (the workspace's creation snapshot), as the supervisor leaves one. */
export function finishedRun(r: Rig, id: string): string {
  const run = r.journal.createRun({ workspaceId: id, kind: "cli", createdBy: "user" }).value;
  r.git(r.repo, "update-ref", `refs/axis/runbase/${run.id}`, r.git(r.repo, "rev-parse", `refs/axis/runbase/${id}`).trim());
  r.journal.transitionRun(run.id, "CANCELLED", { actor: "user" });
  return run.id;
}
