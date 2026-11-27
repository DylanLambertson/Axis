// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { createHash } from "node:crypto";
import { DaemonError, requestDigest, type ApprovalContentHook, type ApprovalContentLock, type Identity } from "@axis/daemon";
import type { PluginState } from "@axis/journal";
import { COMPOSER_RUNS_CONTRACT, COMPOSER_RUNS_VERSION, composerRunsMethods, type ChallengeDetail } from "@axis/protocol";
import { escapedHead } from "../composer/preview.js";
import type { WindowLifetimes } from "../plugins/window-lifetimes.js";
import type { PluginChallengeDeps } from "./plugin-approvals.js";
import { forcedScope } from "./plugin-scope.js";

/**
 * A plugin's `axis.runs/1.start` (PV-K1e-b, `docs/design/plugin-run-start.md` section 3): the content hook, the gate's plugin
 * dependencies and the handler's checks, in that order. Every step reads the plugin's grant from the journal again; none takes a
 * plugin, project, generation or window from the request. A user start is unchanged: its tier-2 path has no approval step, and
 * the hook answers it exactly as the daemon would without one.
 */
export interface PluginRunStartJournal {
  getWorkspace(id: string): { readonly projectId: string; readonly branch: string } | undefined;
  getProject(id: string): { readonly displayName: string } | undefined;
  readonly plugins: { state(pluginId: string, projectId: string): PluginState | undefined };
}

const PERMISSION = "runs.start";
const START = composerRunsMethods.start.request;
const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

/** The plugin id of an attested plugin identity, or undefined for any other caller. */
export function pluginOf(identity: Pick<Identity, "clientKind" | "actor">): string | undefined {
  return identity.clientKind === "plugin" && identity.actor.startsWith("plugin:") ? identity.actor.slice("plugin:".length) : undefined;
}

/** The grant generation if the plugin may start a run in the project now (enabled, `runs.start` granted), else undefined. */
export function grantedGeneration(journal: PluginRunStartJournal, pluginId: string, projectId: string): number | undefined {
  let s: PluginState | undefined;
  try {
    s = journal.plugins.state(pluginId, projectId);
  } catch {
    return undefined;
  }
  return s !== undefined && s.enabled && s.permissions.includes(PERMISSION) ? s.generation : undefined;
}

/** A plugin start's workspace within the pinned project, or undefined (out of scope, or no such workspace). */
export function scopedWorkspace(journal: PluginRunStartJournal, identity: Identity, workspaceId: unknown): { readonly projectId: string; readonly workspaceId: string } | undefined {
  if (typeof workspaceId !== "string") return undefined;
  const scope = forcedScope(identity, { workspaceId }, (id) => journal.getWorkspace(id)?.projectId);
  return scope.ok && scope.projectId !== undefined && scope.workspaceId !== undefined ? { projectId: scope.projectId, workspaceId: scope.workspaceId } : undefined;
}

/** What a plugin's run start was approved for: minted only by `bind` below, recognised only by `approvedStartOf`. */
export interface ApprovedPluginStart {
  readonly pluginId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly generation: number;
  /** The host window and its lifetime epoch when the challenge was issued (PV-K2 K2-g4b); every later check uses these. */
  readonly hostWindowId: string;
  readonly hostEpoch: string;
}

/** The host windows' lifetimes as the binding and the handler read them (`plugins/window-lifetimes.ts`). */
export type HostWindows = Pick<WindowLifetimes, "current" | "alive">;

/** Whether a host window is still in the pinned lifetime; a throw is a closed window. */
export function hostWindowAlive(windows: Pick<HostWindows, "alive">, hostWindowId: string, epoch: string): boolean {
  try {
    return windows.alive(hostWindowId, epoch) === true;
  } catch {
    return false;
  }
}
const MINTED = new WeakSet<object>();
function mintApprovedStart(facts: ApprovedPluginStart): ApprovedPluginStart {
  const out = Object.freeze({ ...facts });
  MINTED.add(out);
  return out;
}
/** The approved facts of a spent plugin start (`ctx.approved.capability`), or undefined for anything the gate did not hand over. */
export function approvedStartOf(capability: unknown): ApprovedPluginStart | undefined {
  return typeof capability === "object" && capability !== null && MINTED.has(capability) ? (capability as ApprovedPluginStart) : undefined;
}

const OUT_OF_SCOPE = (): DaemonError => new DaemonError("E_NOT_FOUND", "Not found", { reason: "out_of_scope" });

/**
 * The content hook of `axis.runs/1.start`. For a plugin: the workspace must belong to the pinned project and the plugin must hold
 * `runs.start` there, else the start is refused with nothing issued; the target is the workspace, and the content digest binds the
 * plugin, its grant generation (read again at issue and at the spend: OI-3), its host window and every field of the start, so a
 * disable, a revoke or any change to the request fails the spend. For anyone else: the daemon's own default, unchanged.
 */
export function runStartContentHook(journal: PluginRunStartJournal): ApprovalContentHook {
  return ((context: { readonly identity: Identity }, payload: unknown): ApprovalContentLock => {
    const { identity } = context;
    const pluginId = pluginOf(identity);
    if (pluginId === undefined) {
      const digest = requestDigest(COMPOSER_RUNS_CONTRACT, COMPOSER_RUNS_VERSION, "start", payload as never);
      return { target: `request:${digest}`, withLock: (fn) => fn(digest) };
    }
    const req = START.safeParse(payload);
    if (!req.success) throw new DaemonError("E_INVALID_ARGUMENT", "Invalid request");
    const scope = scopedWorkspace(journal, identity, req.data.workspaceId);
    if (scope === undefined || grantedGeneration(journal, pluginId, scope.projectId) === undefined) throw OUT_OF_SCOPE();
    const digestNow = (): string => {
      const generation = grantedGeneration(journal, pluginId, scope.projectId);
      // A plugin that lost the grant has no digest the approval can match: the spend fails as a changed content.
      return sha256(JSON.stringify(["axis.plugin-run-start/1", pluginId, generation ?? null, identity.hostWindowId ?? null, scope.workspaceId, req.data.mode, req.data.providerId, req.data.modelId, sha256(req.data.prompt)]));
    };
    return { target: `workspace:${scope.workspaceId}`, withLock: (fn) => fn(digestNow()) };
  }) as unknown as ApprovalContentHook;
}

/**
 * The gate's plugin dependencies for run starts (`PluginChallengeDeps`, PV-K1e-a2-1b): the full request the user approves, built
 * from the journal and the parsed request, and a binding that holds while the plugin keeps `runs.start` at the same generation
 * and its host window stays in the lifetime it was in at issue (PV-K2 K2-g4b, `plugin-grant-contract.md` section 8.4). A host
 * window with no live lifetime refuses the challenge; a close, even one followed by a reopen, ends the binding for good.
 */
export function pluginRunStartChallenges(journal: PluginRunStartJournal, issues: PluginChallengeDeps["issues"], now: () => number, windows: HostWindows): PluginChallengeDeps {
  return {
    bind(input) {
      const pluginId = pluginOf(input.identity);
      if (pluginId === undefined || input.contract !== COMPOSER_RUNS_CONTRACT || input.method !== "start") return undefined;
      const req = START.safeParse(input.args);
      if (!req.success) return undefined;
      const scope = scopedWorkspace(journal, input.identity, req.data.workspaceId);
      if (scope === undefined) return undefined;
      const generation = grantedGeneration(journal, pluginId, scope.projectId);
      if (generation === undefined) return undefined;
      // Pinned now, at issue: the host window's live lifetime. None (the window has no desktop connection) refuses the challenge.
      const hostWindowId = input.identity.hostWindowId;
      if (hostWindowId === undefined) return undefined;
      const hostEpoch = windows.current(hostWindowId);
      if (typeof hostEpoch !== "string") return undefined;
      // Escaped whole: a prompt whose escaped form passes the cap fails the detail's contract and the start is refused, never cut.
      const prompt = escapedHead(req.data.prompt, Number.MAX_SAFE_INTEGER).head;
      const detail = {
        kind: "runs.start",
        requester: { kind: "plugin", pluginId },
        prompt,
        project: journal.getProject(scope.projectId)?.displayName ?? scope.projectId,
        workspace: journal.getWorkspace(scope.workspaceId)?.branch ?? scope.workspaceId,
        mode: req.data.mode,
        provider: req.data.providerId,
        model: req.data.modelId,
      } as ChallengeDetail;
      return {
        pluginId,
        projectId: scope.projectId,
        detail,
        valid: () => grantedGeneration(journal, pluginId, scope.projectId) === generation && hostWindowAlive(windows, hostWindowId, hostEpoch),
        approved: mintApprovedStart({ pluginId, projectId: scope.projectId, workspaceId: scope.workspaceId, generation, hostWindowId, hostEpoch }),
      };
    },
    issues,
    now,
  };
}
