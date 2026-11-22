// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { randomBytes } from "node:crypto";
import { realpath } from "node:fs/promises";
import { basename, dirname, normalize, sep } from "node:path";
import { AxisError } from "@axis/audit";
import type { Env } from "@axis/git-ops";
import type { Journal } from "@axis/journal";
import type { ControlClient } from "../control/client.js";
import type { InboundMessage } from "../control/messages.js";
import type { Logger } from "../log/logger.js";
import { BINDING_TIMEOUT_MS, readRepositoryBinding, type BindingOptions, type BindingResult } from "./binding.js";
import { createRemoteRunner, readRemote, REMOTE_TIMEOUT_MS, type RemoteReaderDeps } from "./remote.js";

/**
 * The project messages of the control channel (docs/design/project-registration-and-trust.md §5.1; `daemon-host.md` §7.4).
 * Only main writes the control channel, and main sends these only after its own native dialog; no protocol method reaches them.
 * The daemon re-derives everything at each message and never takes main's earlier inspection on trust:
 *
 * - `projects.inspect { path }`: the binding (§5.2) and the remote for the dialog (§5.3), and whether it is registered.
 * - `projects.register { path, commonDir, trusted }`: the binding again, which must name the same `commonDir`; the path must not
 *   be equal to, inside or around the daemon's data directory, the worktree root or a registered project. `trusted` comes from
 *   main's dialog ("Add and trust to run").
 * - `projects.trust { projectId, path, commonDir?, trusted }`: a grant re-derives the binding (and re-binds a pre-v11 row); a
 *   revoke needs nothing. The journal records `via: "dialog"` or `"gesture"`.
 *
 * Answers carry closed codes and reasons only; nothing the journal or the filesystem said is forwarded. `journal` is undefined
 * when degraded (nothing may write): every message is then `E_UNAVAILABLE`.
 */
export type ProjectMessage = Extract<InboundMessage, { type: "projects.inspect" | "projects.register" | "projects.trust" }>;

export interface ProjectControlDeps {
  readonly journal: Pick<Journal, "registerProject" | "setProjectTrust" | "getProject" | "listProjects"> | undefined;
  readonly control: Pick<ControlClient, "send">;
  /** The daemon's data directory and the worktree root: no project may be one of them, inside one, or contain one. */
  readonly excludedRoots: readonly string[];
  readonly binding: Omit<BindingOptions, "signal">;
  readonly remote: RemoteReaderDeps;
  /** Test seam: how the excluded roots' real paths are read (default `fs.realpath`). */
  readonly rootsRealpath?: (path: string) => Promise<string>;
  /** After a revoke: stop the project's live runs. Never changes the answer. */
  readonly onRevoked?: (projectId: string) => void;
  readonly logger?: Logger;
}

type Failure = { readonly code: "E_UNAVAILABLE" | "E_CONFLICT" | "E_INVALID_ARGUMENT" | "E_NOT_FOUND" | "E_INTERNAL" | "E_BACKPRESSURE"; readonly reason?: string };

const NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,62}$/;

/** A display name for a project from its folder name; a name that is not plain text becomes a fixed word. */
export function projectDisplayName(path: string): string {
  const base = basename(path);
  return NAME.test(base) ? base : "project";
}

/** `a` is `b` or inside it, by path segments (both absolute, normalised, real). */
const within = (a: string, b: string): boolean => a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);

const refusal = (r: BindingResult & { ok: false }): Failure =>
  r.reason === "unavailable" ? { code: "E_UNAVAILABLE", reason: "binding_unavailable" } : { code: "E_INVALID_ARGUMENT", reason: "not_a_repository" };

function failureOf(e: unknown): Failure {
  if (e instanceof AxisError && (e.code === "E_CONFLICT" || e.code === "E_INVALID_ARGUMENT" || e.code === "E_NOT_FOUND")) return { code: e.code };
  return { code: "E_INTERNAL" };
}

/**
 * Real paths of the excluded roots, read once and bounded (2 s each, as the binding). A root that does not exist yet is kept as
 * given (it still refuses itself). A root whose real path cannot be read in time makes the result INCOMPLETE: every registration
 * and inspection is then refused (fail closed), because a symlinked root's target could not be excluded.
 */
async function realRoots(roots: readonly string[], timeoutMs: number, real: (p: string) => Promise<string>): Promise<{ readonly roots: string[]; readonly complete: boolean }> {
  const out = new Set<string>();
  let complete = true;
  for (const r of roots) {
    out.add(normalize(r));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const bound = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
      });
      const got = await Promise.race([real(r), bound]);
      if (got === "timeout") complete = false;
      else out.add(got);
    } catch (e) {
      // not there (yet): the spelling above still counts; anything else is not known to be safe
      if ((e as { code?: unknown } | null)?.code !== "ENOENT") complete = false;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  return { roots: [...out], complete };
}

/**
 * Project messages waiting at once; main sends one dialog at a time, so more is a misbehaving sender (`E_BACKPRESSURE`). A revoke
 * (`projects.trust` false) is never refused by this bound.
 */
export const MAX_PROJECT_MESSAGES = 16;

export function createProjectControl(deps: ProjectControlDeps): { handle(message: ProjectMessage): Promise<void> } {
  if (!Array.isArray(deps?.excludedRoots) || deps.excludedRoots.length === 0 || deps.excludedRoots.some((r) => typeof r !== "string")) {
    throw new TypeError("the excluded roots must be a non-empty list of paths");
  }
  // Read on the first message that needs them, not at composition (no timer or filesystem work while the host starts), then kept.
  let rootsOnce: ReturnType<typeof realRoots> | undefined;
  const roots = (): ReturnType<typeof realRoots> => (rootsOnce ??= realRoots(deps.excludedRoots, BINDING_TIMEOUT_MS, deps.rootsRealpath ?? ((r) => realpath(r))));
  const send = (m: Parameters<ControlClient["send"]>[0]): void => {
    try {
      deps.control.send(m);
    } catch {
      // the channel is gone; nothing to answer
    }
  };
  const fail = (type: "projects.inspected" | "projects.result", requestId: string, f: Failure): void => {
    deps.logger?.warn("request.failed", { reason: f.reason ?? "project_control", code: f.code });
    send({ type, requestId, ok: false, code: f.code, ...(f.reason === undefined ? {} : { reason: f.reason }) } as never);
  };
  const bind = (path: string, signal?: AbortSignal) => readRepositoryBinding(path, { ...deps.binding, ...(signal === undefined ? {} : { signal }) });

  async function excluded(path: string, journal: NonNullable<ProjectControlDeps["journal"]>): Promise<string | undefined> {
    const known = await roots();
    if (!known.complete) return "roots_unavailable";
    for (const root of known.roots) if (within(path, root) || within(root, path)) return "excluded_root";
    // An identical path is a registered project (inspect answers it, register refuses it `E_CONFLICT` before this).
    for (const p of journal.listProjects()) if (within(path, p.path) || within(p.path, path)) return "nested_project";
    return undefined;
  }

  async function inspect(m: Extract<ProjectMessage, { type: "projects.inspect" }>, journal: NonNullable<ProjectControlDeps["journal"]>): Promise<void> {
    if (normalize(m.path) !== m.path) return fail("projects.inspected", m.requestId, { code: "E_INVALID_ARGUMENT" });
    // One signal for the whole inspection: the binding's bound, then the remote read's.
    const signal = AbortSignal.timeout(BINDING_TIMEOUT_MS + REMOTE_TIMEOUT_MS);
    const b = await bind(m.path, signal);
    if (!b.ok) return fail("projects.inspected", m.requestId, refusal(b));
    const registered = journal.listProjects().find((p) => p.path === m.path);
    const why = registered === undefined ? await excluded(m.path, journal) : undefined;
    if (why !== undefined) return fail("projects.inspected", m.requestId, { code: why === "roots_unavailable" ? "E_UNAVAILABLE" : "E_INVALID_ARGUMENT", reason: why });
    const remote = await readRemote(b.binding, deps.remote, signal);
    send({
      type: "projects.inspected",
      requestId: m.requestId,
      ok: true,
      commonDir: b.binding.commonDir,
      ...(registered === undefined ? {} : { registered: { projectId: registered.id, trusted: registered.trusted } }),
      remoteKnown: remote !== undefined,
      remote: remote?.remote ?? null,
      remotes: remote?.remotes ?? 0,
    });
  }

  async function register(m: Extract<ProjectMessage, { type: "projects.register" }>, journal: NonNullable<ProjectControlDeps["journal"]>): Promise<void> {
    if (normalize(m.path) !== m.path) return fail("projects.result", m.requestId, { code: "E_INVALID_ARGUMENT" });
    const b = await bind(m.path);
    if (!b.ok) return fail("projects.result", m.requestId, refusal(b));
    if (b.binding.commonDir !== m.commonDir) return fail("projects.result", m.requestId, { code: "E_INVALID_ARGUMENT", reason: "binding_changed" });
    if (journal.listProjects().some((p) => p.path === m.path || p.commonDir === m.commonDir)) return fail("projects.result", m.requestId, { code: "E_CONFLICT" });
    const why = await excluded(m.path, journal);
    if (why !== undefined) return fail("projects.result", m.requestId, { code: why === "roots_unavailable" ? "E_UNAVAILABLE" : "E_INVALID_ARGUMENT", reason: why });
    const id = `p-${randomBytes(9).toString("hex")}`;
    const p = journal.registerProject({ id, path: m.path, displayName: projectDisplayName(m.path), trusted: m.trusted, commonDir: b.binding.commonDir, gitDirId: b.binding.gitDirId, actor: "daemon" });
    send({ type: "projects.result", requestId: m.requestId, ok: true, projectId: p.id });
  }

  async function trust(m: Extract<ProjectMessage, { type: "projects.trust" }>, journal: NonNullable<ProjectControlDeps["journal"]>): Promise<void> {
    const row = journal.getProject(m.projectId);
    if (row === undefined) return fail("projects.result", m.requestId, { code: "E_NOT_FOUND" });
    if (row.path !== m.path) return fail("projects.result", m.requestId, { code: "E_INVALID_ARGUMENT", reason: "project_moved" });
    if (!m.trusted) {
      journal.setProjectTrust({ id: row.id, trusted: false, via: "gesture" });
      try {
        deps.onRevoked?.(row.id);
      } catch {
        // stopping runs never changes the answer
      }
      return send({ type: "projects.result", requestId: m.requestId, ok: true, projectId: row.id });
    }
    if (m.commonDir === undefined) return fail("projects.result", m.requestId, { code: "E_INVALID_ARGUMENT" });
    const b = await bind(row.path);
    if (!b.ok) return fail("projects.result", m.requestId, refusal(b));
    if (b.binding.commonDir !== m.commonDir) return fail("projects.result", m.requestId, { code: "E_INVALID_ARGUMENT", reason: "binding_changed" });
    journal.setProjectTrust({ id: row.id, trusted: true, via: "dialog", commonDir: b.binding.commonDir, gitDirId: b.binding.gitDirId });
    send({ type: "projects.result", requestId: m.requestId, ok: true, projectId: row.id });
  }

  // One message at a time: a register's checks and its insert are separated by awaits, so two overlapping registers of nested
  // folders could otherwise both pass (main sends one dialog at a time; this makes it true here as well).
  let queue: Promise<void> = Promise.resolve();
  let waiting = 0;
  const one = async (m: ProjectMessage): Promise<void> => {
    const answer = m.type === "projects.inspect" ? "projects.inspected" : "projects.result";
    const journal = deps.journal;
    if (journal === undefined) return fail(answer, m.requestId, { code: "E_UNAVAILABLE" });
    try {
      if (m.type === "projects.inspect") await inspect(m, journal);
      else if (m.type === "projects.register") await register(m, journal);
      else await trust(m, journal);
    } catch (e) {
      fail(answer, m.requestId, failureOf(e));
    }
  };
  return {
    handle(m) {
      // A revoke only lowers privilege and must never be dropped: it is exempt from the bound (it still waits its turn).
      const revoke = m.type === "projects.trust" && !m.trusted;
      if (waiting >= MAX_PROJECT_MESSAGES && !revoke) {
        fail(m.type === "projects.inspect" ? "projects.inspected" : "projects.result", m.requestId, { code: "E_BACKPRESSURE" });
        return Promise.resolve();
      }
      waiting++;
      const run = queue.then(() => one(m)).finally(() => void waiting--);
      queue = run.catch(() => undefined);
      return run;
    },
  };
}

/**
 * What no project may be, be inside or contain: the Axis data root (`dirname(dataDir)`: the daemon's data, the audit anchor and
 * the pty scratch live there, as `pty-launch.ts` and `anchor-file.ts` define it), the data directory and the worktree root.
 */
export function projectExcludedRoots(config: { readonly dataDir: string; readonly worktreeRoot: string }): string[] {
  return [dirname(config.dataDir), config.dataDir, config.worktreeRoot];
}

/**
 * Wires the project messages of `control` for the composed host: the excluded roots are the data directory and the worktree root,
 * the binding uses this process's uid, and the remote read runs on a node runner over the host's ONE `gitPath` with the daemon's
 * source environment (`daemonGitEnv` filters it). The returned function unsubscribes.
 */
export function installProjectControl(
  control: Pick<ControlClient, "send" | "onProjects">,
  o: {
    readonly journal: ProjectControlDeps["journal"];
    readonly config: { readonly dataDir: string; readonly worktreeRoot: string; readonly platform: NodeJS.Platform };
    readonly gitPath: string;
    readonly env: Env;
    readonly onRevoked?: (projectId: string) => void;
    readonly logger?: Logger;
  },
): () => void {
  const handler = createProjectControl({
    journal: o.journal,
    control,
    excludedRoots: projectExcludedRoots(o.config),
    binding: { platform: o.config.platform, uid: typeof process.getuid === "function" ? process.getuid() : undefined },
    remote: { runner: createRemoteRunner(o.gitPath, o.env), env: o.env, platform: o.config.platform },
    ...(o.onRevoked === undefined ? {} : { onRevoked: o.onRevoked }),
    ...(o.logger === undefined ? {} : { logger: o.logger }),
  });
  return control.onProjects((m) => void handler.handle(m));
}
