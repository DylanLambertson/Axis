// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { AuditEventInput } from "@axis/audit";
import { parseRemote } from "@axis/git-ops";
import {
  FORGE_HOST,
  forgeReplySchema,
  forgeRepositorySchema,
  forgeListRequestSchema,
  type ForgeListRequest,
  type ForgeRefusalReason,
  type ForgeRepository,
  type ForgeResponse,
  type ForgeState,
} from "@axis/protocol";
import { parseForgeList } from "./parse.js";

/**
 * The forge binding (ticket PV-D2, docs/design/forge-pr-list.md §2, §6, §7): which repository, when `gh` runs, and what its
 * answer means. It never starts a program: it sends the pty process a typed `forge-list` (the shared `@axis/protocol`
 * schema) through `ForgeListPort` and maps the closed reply to a closed state. Nothing a pull request author wrote reaches an
 * audit row, a log line, a thrown error or a cache key: the audit carries ids, closed states and counts; the log the state
 * and the exit code; errors are `ForgeRefusal` with a closed reason; the cache is keyed by the project id.
 */

/** The pty process's `forge-list`. The reply is untrusted structure: it is parsed with `forgeReplySchema` here. */
export interface ForgeListPort {
  list(request: ForgeListRequest): Promise<unknown>;
}

/** What `origin` of the project's main checkout says, read by the daemon's own pinned git (`git remote get-url origin`). */
export type OriginRead = { readonly kind: "url"; readonly url: string } | { readonly kind: "none" };

export interface ForgeAuditSink {
  append(input: AuditEventInput): unknown;
}

export const FORGE_AUDIT = { list: "forge.pull_requests", pin: "forge.pin" } as const;
/** The only payload keys the forge rows carry (the host's `AuditLog` drops any other). */
export const FORGE_PAYLOAD_ALLOWLIST: Readonly<Record<string, readonly string[]>> = Object.freeze({
  [FORGE_AUDIT.list]: Object.freeze(["projectId", "trigger", "state", "rows", "invalidRows"]),
  [FORGE_AUDIT.pin]: Object.freeze(["projectId", "fromHost", "fromOwner", "fromRepo", "host", "owner", "repo"]),
});

export interface ForgeLimits {
  /** A `view` answers from a cache younger than this. */
  readonly freshMs: number;
  /** No exec for a project sooner than this after its last one; also how long a failure is cached. */
  readonly minIntervalMs: number;
  /** A list older than this is marked `stale`. */
  readonly staleMs: number;
}
export const DEFAULT_FORGE_LIMITS: ForgeLimits = Object.freeze({ freshMs: 60_000, minIntervalMs: 15_000, staleMs: 600_000 });

/**
 * Where the user's confirmed repository of each project is kept (§2). Slice 2 ships `createMemoryPinStore`: a pin is lost when
 * the daemon restarts, so the project is unconfirmed again (`repository_unconfirmed`, no `gh` runs) until the user confirms it
 * again. The journal store (schema v13) is slice 2b; it implements this interface and nothing else changes.
 */
export interface PinStore {
  get(projectId: string): ForgeRepository | undefined;
  set(projectId: string, repository: ForgeRepository): void;
}

/** The slice 2 pin store: this process's memory only. */
export function createMemoryPinStore(): PinStore {
  const pins = new Map<string, ForgeRepository>();
  return {
    get: (projectId) => pins.get(projectId),
    set: (projectId, repository) => void pins.set(projectId, Object.freeze({ host: repository.host, owner: repository.owner, repo: repository.repo })),
  };
}

export interface ForgeServiceDeps {
  readonly projectExists: (projectId: string) => boolean;
  /** Default: a fresh `createMemoryPinStore()`. */
  readonly pins?: PinStore;
  readonly readOrigin: (projectId: string) => Promise<OriginRead>;
  /** Absent: no pty process is connected (`unavailable`). */
  readonly port?: ForgeListPort;
  readonly audit: ForgeAuditSink;
  readonly monotonic: () => number;
  /** A fresh request id for each `forge-list` (`[A-Za-z0-9_-]{1,64}`). */
  readonly requestId: () => string;
  /** GitHub Enterprise hosts known to the daemon (`unsupported_host` in v1, never sent a credential). */
  readonly enterpriseHosts?: ReadonlySet<string>;
  /** This platform is in `FORGE_AUTH_UNSUPPORTED` (§4): answer `auth_unsupported` without running `gh`. */
  readonly authUnsupported?: boolean;
  /** One line per exec: the state and the exit code only. */
  readonly log?: (line: string) => void;
  readonly limits?: Partial<ForgeLimits>;
}

/** A refusal with a closed reason and a fixed message: never any text from a remote, a pull request or `gh`. */
export class ForgeRefusal extends Error {
  constructor(readonly reason: ForgeRefusalReason) {
    super("forge request refused");
    this.name = "ForgeRefusal";
  }
}

type Answer = ForgeResponse<"pullRequests">;
type Trigger = "view" | "user";

interface Cached {
  readonly answer: Answer;
  readonly at: number;
}

interface ProjectState {
  /** Bumped by every `pinRepository`: an exec that started under an older value is not the answer for the current pin. */
  pinGen: number;
  cache?: Cached | undefined;
  lastExec?: number;
  timeoutLatch: boolean;
  inflight?: Promise<Answer> | undefined;
}

export interface ForgeService {
  pullRequests(projectId: string, trigger: Trigger): Promise<Answer>;
  pinRepository(projectId: string, repository: ForgeRepository): Promise<ForgeResponse<"pinRepository">>;
}

const same = (a: ForgeRepository, b: ForgeRepository): boolean => a.host === b.host && a.owner.toLowerCase() === b.owner.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase();
const AUTH_STATES: ReadonlySet<ForgeState> = new Set(["not_logged_in", "keyring_unavailable"]);

export function createForgeService(deps: ForgeServiceDeps): ForgeService {
  const limits: ForgeLimits = { ...DEFAULT_FORGE_LIMITS, ...deps.limits };
  const projects = new Map<string, ProjectState>();
  const pins = deps.pins ?? createMemoryPinStore();
  const pinOf = (projectId: string): ForgeRepository | undefined => {
    const p = pins.get(projectId);
    // A stored value is used only as a vetted repository; anything else is no pin (fail closed: the user confirms again).
    return p !== undefined && p.host === FORGE_HOST && forgeRepositorySchema.safeParse(p).success ? p : undefined;
  };
  /** The authentication latch is global: the keyring is shared, so one failure must not become one dialog per project (§6). */
  let authLatch: ForgeState | undefined;
  const stateOf = (id: string): ProjectState => {
    let s = projects.get(id);
    if (s === undefined) projects.set(id, (s = { pinGen: 0, timeoutLatch: false }));
    return s;
  };
  const target = (projectId: string): string => `project:${projectId}`;

  /** The vetted repository `origin` names now, or the state that stops here. */
  const resolve = async (projectId: string): Promise<{ repo: ForgeRepository } | { state: ForgeState }> => {
    let origin: OriginRead;
    try {
      origin = await deps.readOrigin(projectId);
    } catch {
      return { state: "no_remote" };
    }
    if (origin.kind === "none") return { state: "no_remote" };
    const r = parseRemote(origin.url);
    if (r === undefined) return { state: "remote_invalid" };
    if (r.host !== FORGE_HOST) return { state: deps.enterpriseHosts?.has(r.host) === true ? "unsupported_host" : "other_forge" };
    return { repo: { host: FORGE_HOST, owner: r.owner, repo: r.repo } };
  };

  const mapReply = (raw: unknown, req: string, pin: ForgeRepository): { answer: Answer; exit: number | null } => {
    let parsed: ReturnType<typeof forgeReplySchema.safeParse>;
    try {
      parsed = forgeReplySchema.safeParse(raw);
    } catch {
      // A getter or Proxy that throws while being read is a malformed reply too (review S1a N3).
      return { answer: { state: "gh_failed", repository: pin }, exit: null };
    }
    if (!parsed.success || parsed.data.req !== req) return { answer: { state: "gh_failed", repository: pin }, exit: null };
    const reply = parsed.data;
    if (reply.t === "forge-failed") {
      const state: ForgeState =
        reply.code === "spawn_missing" ? "gh_missing"
        : reply.code === "too_old" ? "gh_too_old"
        : reply.code === "timeout" ? "timeout"
        : reply.code === "capacity" ? "busy"
        : reply.code === "no_control" ? "unavailable"
        : reply.code === "unsupported_platform" ? "unsupported_platform"
        : reply.code === "bad_request" ? "remote_invalid"
        : "gh_failed";
      return { answer: { state, repository: pin }, exit: null };
    }
    if (reply.truncated) return { answer: { state: "output_too_large", repository: pin }, exit: reply.exit };
    if (reply.exit === 0) {
      const list = parseForgeList(reply.stdout, pin);
      if (list.kind === "invalid") return { answer: { state: "output_invalid", repository: pin }, exit: 0 };
      return { answer: { state: "ok", repository: pin, rows: [...list.rows], incomplete: list.incomplete, invalidRows: list.invalidRows }, exit: 0 };
    }
    const state: ForgeState =
      reply.class === "auth_missing" ? "not_logged_in"
      : reply.class === "keyring" ? "keyring_unavailable"
      : reply.class === "repo_missing" ? "repo_not_found"
      : reply.class === "network" ? "network_unavailable"
      : "gh_failed";
    return { answer: { state, repository: pin }, exit: reply.exit };
  };

  const exec = async (projectId: string, st: ProjectState, pin: ForgeRepository, port: ForgeListPort, trigger: Trigger): Promise<Answer> => {
    const at = deps.monotonic();
    const gen = st.pinGen;
    st.lastExec = at;
    // The request is checked against the shared schema before it leaves (review S1a N4): a bad id is a bug, never sent.
    const request = forgeListRequestSchema.safeParse({ t: "forge-list", req: deps.requestId(), host: FORGE_HOST, owner: pin.owner, repo: pin.repo });
    let outcome: { answer: Answer; exit: number | null };
    if (!request.success) {
      outcome = { answer: { state: "gh_failed", repository: pin }, exit: null };
    } else {
      try {
        outcome = mapReply(await port.list(request.data), request.data.req, pin);
      } catch {
        outcome = { answer: { state: "unavailable", repository: pin }, exit: null };
      }
    }
    const { answer, exit } = outcome;
    // Every exec is logged and audited with the state it produced, whatever happens to its answer next (review S1a SF-2).
    deps.log?.(`forge: state=${answer.state} exit=${exit === null ? "none" : String(exit)}`);
    deps.audit.append({
      actor: "user",
      action: FORGE_AUDIT.list,
      target: target(projectId),
      outcome: answer.state === "ok" ? "success" : "failure",
      payload: { projectId, trigger, state: answer.state, rows: answer.rows?.length ?? 0, invalidRows: answer.invalidRows ?? 0 },
    });
    // The pin changed while `gh` ran (any re-pin, even a case-only one, is a new object): the answer is for the repository
    // that was pinned before. It is neither cached nor returned, and no latch moves; the caller is told to ask again.
    if (st.pinGen !== gen) {
      const retryAfterMs = Math.max(0, Math.ceil(limits.minIntervalMs - (deps.monotonic() - at)));
      const now = pinOf(projectId);
      return { state: "busy", ...(now === undefined ? {} : { repository: now }), retryAfterMs };
    }
    if (AUTH_STATES.has(answer.state)) authLatch = answer.state;
    if (answer.state === "timeout") st.timeoutLatch = true;
    if (answer.state === "ok") {
      authLatch = undefined;
      st.timeoutLatch = false;
    }
    st.cache = { answer, at };
    return answer;
  };

  const fromCache = (c: Cached, now: number, extra: Partial<Answer> = {}): Answer => {
    const ageMs = Math.max(0, now - c.at);
    return { ...c.answer, ageMs, ...(c.answer.state === "ok" && ageMs >= limits.staleMs ? { stale: true } : {}), ...extra };
  };

  return {
    async pullRequests(projectId, trigger) {
      if (!deps.projectExists(projectId)) throw new ForgeRefusal("not_found");
      const st = stateOf(projectId);
      const r = await resolve(projectId);
      const pin = pinOf(projectId);
      if ("state" in r) return { state: r.state, ...(pin === undefined ? {} : { repository: pin }) };
      if (pin === undefined) return { state: "repository_unconfirmed", candidate: r.repo };
      if (!same(pin, r.repo)) return { state: "remote_changed", repository: pin, candidate: r.repo };
      if (deps.authUnsupported === true) return { state: "auth_unsupported", repository: pin };
      if (deps.port === undefined) return { state: "unavailable", repository: pin };
      if (st.inflight !== undefined) return st.inflight;
      const now = deps.monotonic();
      const c = st.cache;
      const sinceExec = st.lastExec === undefined ? Infinity : now - st.lastExec;
      if (trigger === "view") {
        const latched = authLatch !== undefined || st.timeoutLatch;
        if (latched) return c !== undefined ? fromCache(c, now) : { state: authLatch ?? "timeout", repository: pin };
        if (c !== undefined && (c.answer.state === "ok" ? now - c.at < limits.freshMs : sinceExec < limits.minIntervalMs)) return fromCache(c, now);
      }
      // Never sooner than the minimum interval after this project's last exec, latched or not, whatever the trigger.
      if (sinceExec < limits.minIntervalMs) {
        const retryAfterMs = Math.ceil(limits.minIntervalMs - sinceExec);
        return c !== undefined ? fromCache(c, now, { retryAfterMs }) : { state: "busy", repository: pin, retryAfterMs };
      }
      const run = exec(projectId, st, pin, deps.port, trigger);
      st.inflight = run;
      try {
        return await run;
      } finally {
        st.inflight = undefined;
      }
    },

    async pinRepository(projectId, repository) {
      if (!deps.projectExists(projectId)) throw new ForgeRefusal("not_found");
      const r = await resolve(projectId);
      // The user confirms the value the daemon displayed; a remote changed since (by a run, say) is refused, never pinned.
      if ("state" in r || r.repo.owner !== repository.owner || r.repo.repo !== repository.repo || r.repo.host !== repository.host) throw new ForgeRefusal("candidate_changed");
      const st = stateOf(projectId);
      const from = pinOf(projectId);
      pins.set(projectId, r.repo);
      st.pinGen++;
      st.cache = undefined;
      st.timeoutLatch = false;
      deps.audit.append({
        actor: "user",
        action: FORGE_AUDIT.pin,
        target: target(projectId),
        outcome: "success",
        payload: { projectId, ...(from === undefined ? {} : { fromHost: from.host, fromOwner: from.owner, fromRepo: from.repo }), host: r.repo.host, owner: r.repo.owner, repo: r.repo.repo },
      });
      return { repository: r.repo };
    },
  };
}
