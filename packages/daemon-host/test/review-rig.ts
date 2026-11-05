// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { MessagePort } from "node:worker_threads";
import { AuditLog, openDatabase } from "@axis/audit";
import { Daemon, MemoryIdempotencyStore, memoryPair, protocolRegistry, type DaemonAuditEvent, type Identity, type IdentityVerifier, type Policy } from "@axis/daemon";
import { createNodeRunner, MIN_GIT_VERSION, type GitOpsDeps } from "@axis/git-ops";
import { Journal } from "@axis/journal";
import {
  createReviewHandlers,
  createReviewService,
  createTempIndexProvider,
  InMemoryTrustRegistry,
  RULES,
  ReviewedTrees,
  RuleTablePolicy,
  type ReviewAckEvent,
  type ReviewService,
  type RunsService,
} from "../src/index.js";

const PATHS = process.env["PATH"] ?? "/usr/bin:/bin";

/** Why git cannot be used here, or null. No version is assumed beyond the one the product requires. */
export function gitUnavailable(): string | null {
  try {
    const out = execFileSync("git", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const m = /(\d+)\.(\d+)/.exec(out);
    if (!m) return "git version unreadable";
    const [major, minor] = [Number(m[1]), Number(m[2])];
    return major > MIN_GIT_VERSION.major || (major === MIN_GIT_VERSION.major && minor >= MIN_GIT_VERSION.minor) ? null : "git is older than the product minimum";
  } catch {
    return "git is not installed";
  }
}

export type Msg = { id?: string; ok?: boolean; type?: string; result?: Record<string, unknown>; error?: { code: string; message: string; details?: Record<string, unknown> } };

export class Client {
  readonly all: Msg[] = [];
  #n = 0;
  constructor(readonly port: MessagePort) {
    port.on("message", (m: Msg) => void this.all.push(m));
  }
  async until(pred: (m: Msg) => boolean, ms = 60_000): Promise<Msg> {
    const end = Date.now() + ms;
    for (;;) {
      const hit = this.all.find(pred);
      if (hit) return hit;
      if (Date.now() >= end) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  async call(method: string, payload: unknown, key?: string): Promise<Msg> {
    const id = `q${++this.#n}`;
    this.port.postMessage({ v: 1, id, contract: "axis.review", contractVersion: 1, method, payload, ...(key ? { idempotencyKey: key } : {}) });
    return this.until((m) => m.id === id);
  }
  async hello(): Promise<void> {
    this.port.postMessage({ type: "hello", protocolVersions: [1], contracts: [{ id: "axis.review", versions: [1] }] });
    await this.until((m) => m.type !== undefined);
  }
}

/** The attestation is "<actor>#<connection>#<window>". */
const verifier: IdentityVerifier = {
  verify(att) {
    const [actor, conn, windowId] = String(att).split("#");
    return { connectionId: (conn as string).padEnd(22, "_"), windowId: windowId as string, actorId: `${actor}-id`, actor: actor as Identity["actor"], trusted: true, clientKind: "desktop" };
  },
};

export interface RigOptions {
  /** Replace the review service (a fake, to drive one handler rule at a time). */
  review?: (real: ReviewService) => ReviewService;
  policy?: Policy;
  failAudit?: boolean;
  /** Skip creating the base commit (an unborn branch). */
  unborn?: boolean;
  /** A workspace state other than READY. */
  workspaceNotReady?: boolean;
  /** Make `runs.get` throw. */
  runsFail?: boolean;
}

export async function reviewRig(options: RigOptions = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "axis-h10b-")));
  const home = join(root, "home");
  mkdirSync(home);
  const genv = { PATH: PATHS, HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
  const repo = join(root, "repo");
  const git = (...a: string[]): string => execFileSync("git", a, { cwd: repo, env: genv, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  mkdirSync(repo);
  git("init", "-q");
  git("symbolic-ref", "HEAD", "refs/heads/axis/feat");
  git("config", "commit.gpgsign", "false");
  const write = (rel: string, data: string | Buffer): void => {
    const p = join(repo, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, data);
  };
  write("keep.txt", "keep\n");
  if (!options.unborn) {
    git("add", "-A");
    git("commit", "-q", "-m", "base");
  }

  const runner = createNodeRunner({ allowPtyContext: true, allowUnpinnedGit: true });
  const gitOps: GitOpsDeps = { runner, env: { daemon: { PATH: PATHS, HOME: home }, pty: { PATH: PATHS, HOME: home } }, runHooks: false, isCliRunActive: () => false, assertNoDrift: async () => undefined };
  const indexDir = join(root, "indexes");
  mkdirSync(indexDir);
  const workspaces = new Map<string, string>();
  const locator = {
    async locate(id: string) {
      const dir = workspaces.get(id);
      if (dir === undefined) throw Object.assign(new Error("unknown"), { code: "E_NOT_FOUND" });
      return { workTree: dir, gitDir: join(dir, ".git") };
    },
  };
  const real = createReviewService({ git: gitOps, locator, tempIndex: createTempIndexProvider(indexDir), fileExists: async (p) => existsSync(p) });

  const db = openDatabase(":memory:");
  const audit = new AuditLog(db);
  const journal = Journal.open(db, { audit });
  const newWorkspace = (ready = true): string => {
    const id = journal.createWorkspace({ projectId: "p", branch: "axis/feat", baseRef: "main", baseSha: "b".repeat(40), createdBy: "user" }).value.id;
    if (ready) journal.transitionWorkspace(id, "READY");
    workspaces.set(id, repo);
    return id;
  };
  const workspaceId = newWorkspace(!options.workspaceNotReady);
  const newRun = (to: "QUEUED" | "RUNNING" | "REVIEWING" = "REVIEWING"): string => {
    const id = journal.createRun({ workspaceId, kind: "cli", createdBy: "user" }).value.id;
    if (to !== "QUEUED") journal.transitionRun(id, "RUNNING");
    if (to === "REVIEWING") journal.transitionRun(id, "REVIEWING");
    return id;
  };

  const transitionOptions: Array<unknown> = [];
  const calls = { recordReviewedTree: 0, transitionRun: 0, open: 0 };
  const spyJournal = {
    recordReviewedTree: ((...a: Parameters<Journal["recordReviewedTree"]>) => (calls.recordReviewedTree++, journal.recordReviewedTree(...a))) as Journal["recordReviewedTree"],
    getRun: (id: string) => journal.getRun(id),
    getWorkspace: (id: string) => journal.getWorkspace(id),
    transitionRun: ((...a: Parameters<Journal["transitionRun"]>) => (calls.transitionRun++, transitionOptions.push(a[2]), journal.transitionRun(...a))) as Journal["transitionRun"],
  };
  const spyReview: ReviewService = { open: (id, ctx) => (calls.open++, (options.review ? options.review(real) : real).open(id, ctx)) };
  const runs: Pick<RunsService, "get"> = {
    get(runId) {
      if (options.runsFail) throw new Error("runs down");
      const r = journal.getRun(runId);
      if (!r) throw new Error("no run");
      const done = r.state === "COMPLETED";
      return {
        runId, workspaceId: r.workspaceId, state: r.state, status: "finished", reason: null, exitCode: null, createdAt: r.createdAt, startedAt: r.startedAt ?? r.createdAt,
        endedAt: done ? (r.endedAt ?? r.updatedAt) : null, live: false, lastOutputAt: null, outputChars: 0, droppedChars: 0, snapshotAfter: "ok",
      };
    },
  };

  const acks: ReviewAckEvent[] = [];
  const trees = new ReviewedTrees();
  const rpcEvents: DaemonAuditEvent[] = [];
  const daemon = new Daemon({
    identity: verifier,
    audit: { append: (e) => void rpcEvents.push(e) },
    registry: protocolRegistry,
    idempotency: new MemoryIdempotencyStore(),
    policy: options.policy ?? new RuleTablePolicy(new InMemoryTrustRegistry(), RULES),
  });
  daemon.register("axis.review", 1, createReviewHandlers({
    review: spyReview,
    journal: spyJournal,
    runs,
    trees,
    audit: { append: (e) => { if (options.failAudit) throw new Error("audit down"); acks.push(e); } },
  }));
  const ports: MessagePort[] = [];
  let conn = 0;
  return {
    root, repo, git, write, journal, trees, transitionOptions, acks, calls, rpcEvents, workspaceId, newWorkspace, newRun, genv,
    async connect(actor = "user"): Promise<Client> {
      const { client, server } = memoryPair();
      ports.push(client);
      const c = new Client(client);
      daemon.accept(server, `${actor}#c${++conn}#w1`);
      await c.hello();
      return c;
    },
    cleanup(): void {
      daemon.stop();
      for (const p of ports) p.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
export type ReviewRig = Awaited<ReturnType<typeof reviewRig>>;

export const sha256 = async (s: string): Promise<string> => (await import("node:crypto")).createHash("sha256").update(s, "utf8").digest("hex");
/** A line longer than the view cuts (1024 code points at the wire's display bound). */
export const LONG_LINE = `${"x".repeat(3000)}\n`;
export const uuid = (): string => globalThis.crypto.randomUUID();
export const files = (m: Msg): Array<Record<string, unknown>> => (m.result?.["files"] ?? []) as Array<Record<string, unknown>>;
