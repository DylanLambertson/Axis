// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { createHash } from "node:crypto";
import type { ChallengeAuditSink } from "@axis/challenge";
import { ApprovalError, type ApprovalContent, type ApprovalInput } from "@axis/daemon";
import type { PluginIssueRecords } from "@axis/journal";
import { MAX_PLUGIN_CHALLENGES_PER_WINDOW, challengeDetailSchema, type ChallengeDetail, type ChallengeRequester } from "@axis/protocol";

/**
 * The challenge gate's plugin branch (PV-K1e-a2, `docs/design/plugin-run-start.md`, ADR 0003 D4 as ADR 0008 amends it).
 *
 * - **Addressed to the host window.** A challenge a plugin caused is issued with the plugin as requester and its own connection
 *   (so only it can consume the approval) and the attested `hostWindowId` as its window (so only the user there lists, reads and
 *   resolves it, under the same window rule as any challenge). Never the plugin view's own `p<n>`.
 * - **Bound.** The binding the daemon builds (`PluginChallengeDeps.bind`) carries the full request the user approves and a
 *   `valid()` check of the plugin's grant generation and host window. It is checked at issue, at resolve, at every detail read
 *   and before the approval is spent; a binding that no longer holds ends the challenge.
 * - **Bounded** (OI-2, OI-10): one open challenge per plugin, `MAX_PLUGIN_CHALLENGES_PER_WINDOW` open per host window across
 *   plugins, and 6 per plugin and project in any hour (the journal's counter, schema v17). Tier 4 is never reached from a plugin.
 * - **Inert until PV-K1e-b.** Without `PluginChallengeDeps` every plugin challenge is refused before anything exists; the host
 *   composition does not pass them until the plugin handlers open.
 *
 * Native confirmation exists only at tier 4 and above: a plugin's run start is tier 3 and is resolved by the renderer's own
 * resolve. Its protection is the run's taint, the full prompt on the card and an approval for each side effect of the run.
 */
export interface PluginChallengeBinding {
  readonly pluginId: string;
  readonly projectId: string;
  /** The full request the user approves, built by the daemon from the request and the journal (never from the plugin's words alone). */
  readonly detail: ChallengeDetail;
  /** Whether the binding still holds now: the plugin's grant generation is unchanged and its host window is open. Synchronous. */
  valid(): boolean;
}

export interface PluginChallengeDeps {
  /** The binding of one plugin challenge, or undefined to refuse it. A throw refuses it too. */
  bind(input: ApprovalInput, content: ApprovalContent): PluginChallengeBinding | undefined;
  readonly issues: Pick<PluginIssueRecords, "record">;
  /** Epoch milliseconds for the hourly counter. */
  readonly now: () => number;
}

interface Tracked {
  readonly actor: string;
  readonly connectionId: string;
  readonly hostWindowId: string;
  readonly target: string;
  readonly requester: ChallengeRequester;
  readonly detail: ChallengeDetail;
  readonly valid: () => boolean;
  /** Monotonic: past it the challenge and any approval of it have expired, so it no longer counts. */
  readonly deadline: number;
}

export interface PreparedPluginChallenge {
  readonly windowId: string;
  readonly track: (challengeId: string) => void;
}

const holds = (valid: () => boolean): boolean => {
  try {
    return valid() === true;
  } catch {
    return false;
  }
};

export class PluginChallenges {
  readonly #deps: PluginChallengeDeps | undefined;
  readonly #monotonic: () => number;
  readonly #lifetimeMs: number;
  readonly #audit: ChallengeAuditSink;
  readonly #live = new Map<string, Tracked>();

  constructor(options: { deps: PluginChallengeDeps | undefined; monotonic: () => number; lifetimeMs: number; audit: ChallengeAuditSink }) {
    this.#deps = options.deps;
    this.#monotonic = options.monotonic;
    this.#lifetimeMs = options.lifetimeMs;
    this.#audit = options.audit;
  }

  /**
   * Check a plugin's challenge before it exists and spend one issue of its hour. Throws `ApprovalError` for every refusal, so
   * nothing is issued: no dependencies (PV-K1e-b not wired), tier 4 or above, no binding, a binding that does not hold, a
   * detail outside its contract shape, or a bound reached.
   */
  prepare(input: ApprovalInput, content: ApprovalContent): PreparedPluginChallenge {
    const deps = this.#deps;
    const host = input.identity.hostWindowId;
    if (deps === undefined || input.tier >= 4 || host === undefined || input.actor !== input.identity.actor) throw new ApprovalError("E_POLICY_DENIED");
    let binding: PluginChallengeBinding | undefined;
    try {
      binding = deps.bind(input, content);
    } catch {
      binding = undefined;
    }
    if (binding === undefined || `plugin:${binding.pluginId}` !== input.actor) throw new ApprovalError("E_POLICY_DENIED");
    const { pluginId, projectId } = binding;
    const valid = binding.valid.bind(binding);
    // A prompt the detail cannot carry whole (over the cap once escaped) is refused here, never cut.
    const detail = challengeDetailSchema.safeParse(binding.detail);
    if (!detail.success || detail.data.requester.pluginId !== pluginId || !holds(valid)) throw new ApprovalError("E_INVALID_ARGUMENT");
    this.#sweep();
    let mine = 0;
    let inWindow = 0;
    for (const t of this.#live.values()) {
      if (t.actor === input.actor) mine++;
      if (t.hostWindowId === host) inWindow++;
    }
    if (mine >= 1 || inWindow >= MAX_PLUGIN_CHALLENGES_PER_WINDOW) throw new ApprovalError("E_BACKPRESSURE");
    // Last, so a refusal above spends nothing of the hour. A challenge the manager then refuses still counts (fail closed).
    let counted;
    try {
      counted = deps.issues.record(pluginId, projectId, deps.now());
    } catch {
      throw new ApprovalError("E_BACKPRESSURE");
    }
    if (!counted.ok) throw new ApprovalError("E_BACKPRESSURE");
    const entry = { actor: input.actor, connectionId: input.connectionId, hostWindowId: host, target: content.target, requester: { kind: "plugin" as const, pluginId }, detail: detail.data, valid };
    return {
      windowId: host,
      track: (challengeId) => void this.#live.set(challengeId, { ...entry, deadline: this.#monotonic() + this.#lifetimeMs }),
    };
  }

  /** The listing's requester of a challenge, if a plugin caused it. */
  requester(challengeId: string): ChallengeRequester | undefined {
    return this.#live.get(challengeId)?.requester;
  }

  /**
   * Whether a plugin challenge may go on: `undefined` for a challenge no plugin caused, else whether its binding still holds. A
   * plugin challenge whose binding no longer holds is forgotten here; the caller ends it with the manager (`end`).
   */
  holds(challengeId: string): { readonly plugin: false } | { readonly plugin: true; readonly ok: boolean; readonly actor: string; readonly connectionId: string; readonly hostWindowId: string } {
    this.#sweep();
    const t = this.#live.get(challengeId);
    if (t === undefined) return { plugin: false };
    const ok = holds(t.valid);
    if (!ok) this.#live.delete(challengeId);
    return { plugin: true, ok, actor: t.actor, connectionId: t.connectionId, hostWindowId: t.hostWindowId };
  }

  /**
   * The detail of a pending plugin challenge for the user in its host window, or undefined (the same for an unknown id, another
   * window, a non-user or non-desktop caller, an ended challenge and a binding that no longer holds). Audited by reference only.
   */
  detail(caller: { readonly actor: string; readonly windowId: string; readonly clientKind: string }, challengeId: string, listed: boolean): ChallengeDetail | undefined {
    this.#sweep();
    const t = this.#live.get(challengeId);
    if (caller.actor !== "user" || caller.clientKind !== "desktop" || t === undefined || !listed || t.hostWindowId !== caller.windowId) return undefined;
    if (!holds(t.valid)) return undefined;
    try {
      const ref = createHash("sha256").update(challengeId, "utf8").digest("hex").slice(0, 12);
      const target = `sha256:${createHash("sha256").update(t.target, "utf8").digest("hex")}`;
      this.#audit.append({ actor: "user", action: "tier4.challenge", target, outcome: "success", payload: { phase: "detail", ref, requester: t.actor } });
    } catch {
      return undefined; // a read that cannot be audited is not answered
    }
    return structuredClone(t.detail);
  }

  forget(challengeId: string): void {
    this.#live.delete(challengeId);
  }

  forgetConnection(connectionId: string): void {
    for (const [id, t] of this.#live) if (t.connectionId === connectionId) this.#live.delete(id);
  }

  clear(): void {
    this.#live.clear();
  }

  get size(): number {
    return this.#live.size;
  }

  #sweep(): void {
    const now = this.#monotonic();
    for (const [id, t] of this.#live) if (now >= t.deadline) this.#live.delete(id);
  }
}
