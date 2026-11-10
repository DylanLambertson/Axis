// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { MessagePort } from "node:worker_threads";
import { AuditLog, openDatabase } from "@axis/audit";
import {
  DaemonError,
  Daemon,
  MemoryIdempotencyStore,
  memoryPair,
  protocolRegistry,
  type DaemonAuditEvent,
  type Identity,
  type IdentityVerifier,
  type Policy,
} from "@axis/daemon";
import { createNodeRunner, resolveGit, type GitRunner } from "@axis/git-ops";
import { Journal } from "@axis/journal";
import { createSecretScanner, type ScanMode } from "@axis/secret-scan";
import {
  ChannelMux,
  ControlClient,
  InMemoryTrustRegistry,
  ProjectMutex,
  PushedBases,
  ReviewedTrees,
  RULES,
  RuleTablePolicy,
  anchorPreflight,
  createApprovals,
  createApprovalsHandlers,
  createCommitPreparer,
  createGitOperations,
  createGitPort,
  createHandlerRegistrar,
  createReviewHandlers,
  createReviewService,
  createTempIndexProvider,
  registerGitHandlers,
  type CommitPreparer,
  type GitHandlerDeps,
  type GitOperations,
  type RunsService,
  type SshHostResolver,
} from "../src/index.js";
import { memoryChannelPair } from "../testing/memory-channel.js";
import { Client, gitUnavailable } from "./review-rig.js";
import { fakeClock } from "./helpers.js";

export { Client, gitUnavailable };
const PATHS = process.env["PATH"] ?? "/usr/bin:/bin";

export interface GitRigOptions {
  scanMode?: ScanMode;
  /** Scanner limits (a tiny `maxBytes` makes every scan incomplete). */
  maxBytes?: number;
  policy?: Policy;
  ops?: (real: GitOperations) => GitOperations;
  resolveSshHost?: SshHostResolver;
  review?: (real: CommitPreparer) => CommitPreparer;
  runsActive?: boolean;
  /** Make `journal.recordPushed` throw. */
  recordPushedFails?: boolean;
  /** The pty git context: a node runner (default), none, or one the test builds over the rig's home and git (the real pty process). */
  ptyRunner?: "node" | "none" | ((env: { home: string; gitPath: string; path: string }) => GitRunner);
  /** The drift check of the git port (default: no drift). */
  assertNoDrift?: () => Promise<void>;
}

/** A real repository on `axis/feat`, a bare remote named `origin`, the real daemon, gate, registrar and git handlers. */
export async function gitRig(options: GitRigOptions = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "axis-h9-")));
  const home = join(root, "home");
  mkdirSync(home);
  const genv = { PATH: PATHS, HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
  const repo = join(root, "repo");
  const remote = join(root, "remote.git");
  const git = (...a: string[]): string => execFileSync("git", a, { cwd: repo, env: genv, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", "--bare", remote], { env: genv, stdio: "ignore" });
  git("init", "-q");
  git("symbolic-ref", "HEAD", "refs/heads/axis/feat");
  git("config", "commit.gpgsign", "false");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("remote", "add", "origin", remote);
  const write = (rel: string, data: string | Buffer): void => {
    const p = join(repo, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, data);
  };
  write("keep.txt", "keep\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  const baseSha = git("rev-parse", "HEAD").trim();

  const gitPath = resolveGit({ PATH: PATHS }, process.platform) as string;
  const scanner = createSecretScanner({ mode: options.scanMode ?? "refuse", ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }) });
  const ptyCalls: string[] = [];
  const nodePty = createNodeRunner({ allowPtyContext: true, allowUnpinnedGit: true });
  const inner: GitRunner = typeof options.ptyRunner === "function" ? options.ptyRunner({ home, gitPath, path: PATHS }) : nodePty;
  const ptyRunner: GitRunner = { run: (req) => (ptyCalls.push(req.context), inner.run(req)) };
  const gitPort = createGitPort({
    gitPath,
    env: { daemon: { PATH: PATHS, HOME: home }, pty: { PATH: PATHS, HOME: home } },
    platform: process.platform,
    runHooks: false,
    scanner,
    ...(options.ptyRunner === "none" ? {} : { ptyRunner }),
    assertNoDrift: options.assertNoDrift ?? (async () => undefined),
  });

  const db = openDatabase(":memory:");
  const audit = new AuditLog(db);
  const journal = Journal.open(db, { audit });
  const workspaces = new Map<string, string>();
  const locator = {
    async locate(id: string) {
      const dir = workspaces.get(id);
      if (dir === undefined) throw Object.assign(new Error("unknown"), { code: "E_NOT_FOUND" });
      return { workTree: dir, gitDir: join(dir, ".git") };
    },
  };
  const newWorkspace = (branch = "axis/feat"): string => {
    const id = journal.createWorkspace({ projectId: "p", branch, baseRef: "main", baseSha, createdBy: "user" }).value.id;
    journal.transitionWorkspace(id, "READY");
    workspaces.set(id, repo);
    return id;
  };
  const workspaceId = newWorkspace();

  const gate = { runsActive: options.runsActive ?? false, stalled: false, branchOverride: undefined as string | undefined, recordPushed: [] as string[], bookkeeping: [] as unknown[], internal: [] as unknown[] };
  const runs: Pick<RunsService, "hasActiveRun"> = { hasActiveRun: () => gate.runsActive };
  const calls = { planPush: [] as Array<{ baseSha: string; branch: string; remote: string }>, executePush: 0, executeCommit: 0, prepare: 0, restoreIndex: 0, assertFresh: 0 };
  const realOps = createGitOperations({ git: gitPort, runs, ...(options.resolveSshHost === undefined ? {} : { resolveSshHost: options.resolveSshHost }) });
  const baseOps: GitOperations = {
    ...realOps,
    planPush: (c) => (calls.planPush.push({ baseSha: c.baseSha, branch: c.branch, remote: c.remote }), realOps.planPush(c)),
    executePush: (c, p) => (calls.executePush++, realOps.executePush(c, p)),
    executeCommit: (c, i) => (calls.executeCommit++, realOps.executeCommit(c, i)),
  };
  const ops = options.ops ? options.ops(baseOps) : baseOps;
  const indexDir = join(root, "indexes");
  mkdirSync(indexDir);
  const reviewDeps = { git: gitPort, locator, tempIndex: createTempIndexProvider(indexDir), fileExists: async (p: string) => existsSync(p) };
  const review = createReviewService(reviewDeps);
  const realPreparer = createCommitPreparer(reviewDeps);
  const spyPreparer: CommitPreparer = {
    prepare: async (h, c) => {
      calls.prepare++;
      const p = await realPreparer.prepare(h, c);
      return { handoff: (m, a) => p.handoff(m, a), restoreIndex: () => (calls.restoreIndex++, p.restoreIndex()) };
    },
    assertFresh: (h) => (calls.assertFresh++, realPreparer.assertFresh(h)),
  };
  const preparer = options.review ? options.review(spyPreparer) : spyPreparer;

  const trees = new ReviewedTrees();
  const spyJournal = {
    getWorkspace: (id: string) => {
      const ws = journal.getWorkspace(id);
      return ws !== undefined && gate.branchOverride !== undefined ? { ...ws, branch: gate.branchOverride } : ws;
    },
    recordPushed: ((...a: Parameters<Journal["recordPushed"]>) => {
      if (options.recordPushedFails) throw new Error("journal down");
      gate.recordPushed.push(a[1]);
      return journal.recordPushed(...a);
    }) as Journal["recordPushed"],
    recordReviewedTree: journal.recordReviewedTree.bind(journal),
    getRun: journal.getRun.bind(journal),
    transitionRun: journal.transitionRun.bind(journal),
  };

  const clock = fakeClock();
  const { a, b } = memoryChannelPair();
  const mux = new ChannelMux(a);
  const control = new ControlClient({ mux });
  const supervisor: Array<Record<string, unknown>> = [];
  b.onMessage((m) => supervisor.push(m as Record<string, unknown>));
  const guard = {
    check(tier: number): void {
      if (gate.stalled && tier >= 3) throw new DaemonError("E_UNAVAILABLE", "The audit anchor is stalled.", { reason: "anchor_stalled" });
    },
  };
  const approvals = createApprovals({ audit: { append: () => undefined }, control, clock, preflight: anchorPreflight(guard) });
  const rpcEvents: DaemonAuditEvent[] = [];
  const trust = new InMemoryTrustRegistry();
  trust.set({ windowId: "w1" }, true);
  const verifier: IdentityVerifier = {
    verify(att) {
      const [actor, conn, windowId] = String(att).split("#");
      return { connectionId: (conn as string).padEnd(22, "_"), windowId: windowId as string, actorId: `${actor}-id`, actor: actor as Identity["actor"], trusted: true, clientKind: "desktop" };
    },
  };
  const daemon = new Daemon({
    identity: verifier,
    audit: { append: (e) => void rpcEvents.push(e) },
    registry: protocolRegistry,
    idempotency: new MemoryIdempotencyStore(),
    policy: options.policy ?? new RuleTablePolicy(trust, RULES),
    approvals: approvals.gate,
  });
  daemon.register("axis.approvals", 1, createApprovalsHandlers({ approvals: approvals.port }));
  daemon.register("axis.review", 1, createReviewHandlers({ review, journal: spyJournal, runs: { get: () => { throw new Error("unused"); } }, trees, audit: { append: () => undefined } }));
  const handlerDeps: GitHandlerDeps = {
    ops,
    review: preparer,
    trees,
    journal: spyJournal,
    locator,
    mutex: new ProjectMutex(),
    needsAttention: () => false,
    anchors: guard,
    runs,
    bases: new PushedBases(),
    onInternalError: (e) => void gate.internal.push(e),
    onBookkeepingError: (e) => void gate.bookkeeping.push(e),
  };
  registerGitHandlers(createHandlerRegistrar(daemon, guard), handlerDeps);

  const ports: MessagePort[] = [];
  let conn = 0;
  const rig = {
    root, repo, remote, git, write, genv, journal, trees, calls, gate, rpcEvents, workspaceId, newWorkspace, baseSha, gitPort, handlerDeps, ptyCalls, supervisor,
    approvals,
    /** HEAD of the repository, and the tip of the remote's branch (null when it has none). */
    head: (): string => git("rev-parse", "HEAD").trim(),
    remoteTip: (): string | null => {
      try {
        return execFileSync("git", ["--git-dir", remote, "rev-parse", "--verify", "--quiet", "refs/heads/axis/feat"], { env: genv, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      } catch {
        return null;
      }
    },
    async connect(actor = "user"): Promise<GitClient> {
      const { client, server } = memoryPair();
      ports.push(client);
      const c = new GitClient(client);
      daemon.accept(server, `${actor}#c${++conn}#w1`);
      await c.hello();
      return c;
    },
    /** The next native.confirm the supervisor was sent, answered as confirmed. */
    async confirmNative(challengeId: string): Promise<void> {
      const end = Date.now() + 5000;
      let sent: Record<string, unknown> | undefined;
      while ((sent = supervisor.filter((m) => m["type"] === "native.confirm").find((m) => m["challengeId"] === challengeId)) === undefined) {
        if (Date.now() > end) throw new Error("no native confirmation");
        await new Promise((r) => setTimeout(r, 5));
      }
      b.send({ type: "native.result", challengeId, proof: String(sent["proof"]), confirmed: true, windowId: "w1" });
    },
    cleanup(): void {
      approvals.dispose();
      control.dispose();
      mux.dispose();
      daemon.stop();
      for (const p of ports) p.close();
      b.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
  return rig;
}
export type GitRig = Awaited<ReturnType<typeof gitRig>>;

/** A client that can call any of the contracts the rig serves. */
export class GitClient extends Client {
  #n = 1000;
  async rpc(contract: string, method: string, payload: unknown, key?: string): Promise<Msg2> {
    const id = `g${++this.#n}`;
    this.port.postMessage({ v: 1, id, contract, contractVersion: 1, method, payload, ...(key ? { idempotencyKey: key } : {}) });
    return this.until((m) => m.id === id);
  }
  override async hello(): Promise<void> {
    this.port.postMessage({ type: "hello", protocolVersions: [1], contracts: [{ id: "axis.review", versions: [1] }, { id: "axis.git", versions: [1] }, { id: "axis.approvals", versions: [1] }] });
    await this.until((m) => m.type !== undefined);
  }
}
type Msg2 = Awaited<ReturnType<Client["call"]>>;
