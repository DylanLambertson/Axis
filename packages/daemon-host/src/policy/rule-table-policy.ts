// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { Policy, PolicyDecision, PolicyInput } from "@axis/daemon";
import type { TrustRegistry } from "../ports/trust.js";
import { RULES } from "./rules.js";
import { ruleKey, type Rule } from "./rule-types.js";
import { PLUGIN_MAX_TIER, PLUGIN_METHOD_SETS, PLUGIN_SET_TIER, pluginDenied } from "./plugin-rules.js";

const DENY: PolicyDecision = Object.freeze({ effect: "deny" });

/**
 * What a web client (any `clientKind` but `desktop`; minted only by the web host entry, `docs/design/web-host-entry.md`
 * W-5) may call until a web approval and trust surface exists (Phase 2): exactly these reads, and only while the call is
 * a read. An allow-list, so a method added later is refused to web clients until someone decides its web reach (the
 * whole-table test fails until then). Not listed on purpose: all of `axis.approvals` (every web tab shares one window,
 * DMN-3), every write, CLI run starts (per-start trust) and anything above tier 1.
 */
export const WEB_ALLOWED: ReadonlySet<string> = new Set([
  "axis.worktrees/1.list",
  "axis.worktrees/1.status",
  "axis.projects/1.list",
  "axis.audit/1.status",
  "axis.audit/1.list",
  "axis.audit/1.verify",
  "axis.cli-runs/1.get",
  "axis.cli-runs/1.list",
  "axis.providers/1.list",
  "axis.git/1.pushPlan",
  "axis.git/1.compareUrl",
  "axis.review/1.diff",
  "axis.runs/1.get",
  "axis.runs/1.list",
  "axis.runs/1.events",
  "axis.events/1.subscribe",
  "axis.events/1.unsubscribe",
]);
/** A second fence under `WEB_ALLOWED`: a web call must also be at most this tier and a read. */
export const WEB_MAX_TIER = 1;
/** The window id the web host attests every web socket with; no desktop identity may use it (X1b mints `w<n>`). */
export const WEB_WINDOW_ID = "web";

/**
 * The daemon's `Policy`, answering from the rule table. It fails closed on everything it does not recognise: a method
 * with no row, an actor that is not `user` (including `agent:*` and `daemon`), a malformed identity or input, a
 * trust condition that is not met, and any throw. It may raise a tier above the contract minimum, never lower it.
 */
/** What the policy reads for a plugin call (the journal's `plugins.state`). */
export interface PluginGrantReader {
  state(pluginId: string, projectId: string): { readonly enabled: boolean; readonly permissions: readonly string[] } | undefined;
}

export class RuleTablePolicy implements Policy {
  readonly #rules: ReadonlyMap<string, Rule>;
  readonly #trust: TrustRegistry;
  readonly #plugins: PluginGrantReader | undefined;
  readonly #sets: Readonly<Record<string, readonly string[]>>;

  /** `plugins` absent: every plugin call is denied. `sets` is a test seam (default: the shipped `PLUGIN_METHOD_SETS`). */
  constructor(trust: TrustRegistry, rules: Readonly<Record<string, Rule>> = RULES, plugins?: PluginGrantReader, sets: Readonly<Record<string, readonly string[]>> = PLUGIN_METHOD_SETS) {
    this.#trust = trust;
    this.#rules = new Map(Object.entries(rules));
    this.#plugins = plugins;
    this.#sets = sets;
  }

  evaluate(input: PolicyInput): PolicyDecision {
    try {
      return this.#decide(input);
    } catch {
      return DENY;
    }
  }

  #decide(input: PolicyInput): PolicyDecision {
    if (typeof input !== "object" || input === null) return DENY;
    const { identity, contract, version, method, tier, sideEffect } = input; // each field is read exactly once
    if (typeof contract !== "string" || typeof method !== "string" || !Number.isInteger(version)) return DENY;
    if (!Number.isInteger(tier) || tier < 0 || tier > 5) return DENY;
    const key = ruleKey(contract, version, method);
    const rule = this.#rules.get(key);
    if (rule === undefined) return DENY;
    if (typeof identity !== "object" || identity === null) return DENY;
    // A plugin connection is decided here and only here: never by the user rows, the web fence or a default (ADR 0008 decision 4).
    if (identity.clientKind === "plugin" || (typeof identity.actor === "string" && identity.actor.startsWith("plugin:"))) return this.#decidePlugin(key, rule, tier, identity);
    if (!rule.actors.some((a) => a === identity.actor)) return DENY;
    if (identity.clientKind === "desktop" ? identity.windowId === WEB_WINDOW_ID : !webAllowed(rule, key, tier, sideEffect)) return DENY;
    if (!this.#trustOk(rule, identity)) return DENY;
    return rule.tier > tier ? { effect: "allow", tier: rule.tier } : { effect: "allow" };
  }

  /**
   * A plugin call (PV-K1b): allowed only when the method is in the set of a permission granted to this plugin in the project
   * it is pinned to and the plugin is enabled there; never a denied method; the tier is the highest of the method's, the user
   * row's and the set's, and refused at 4 or more; the user row's trust mode applies, with a revoke of the view's or the host
   * window refusing. An unknown plugin, an ungranted method and a disabled plugin get the same refusal.
   */
  #decidePlugin(key: string, rule: Rule, tier: number, identity: PolicyInput["identity"]): PolicyDecision {
    const reader = this.#plugins;
    if (reader === undefined || identity.clientKind !== "plugin" || typeof identity.actor !== "string" || !identity.actor.startsWith("plugin:")) return DENY;
    const projectId = identity.workspaceId;
    if (typeof projectId !== "string" || projectId === "" || pluginDenied(key)) return DENY;
    const state = reader.state(identity.actor.slice("plugin:".length), projectId);
    if (state === undefined || state.enabled !== true) return DENY;
    if (!state.permissions.some((p) => this.#sets[p]?.includes(key) === true)) return DENY;
    const effective = Math.max(tier, rule.tier, PLUGIN_SET_TIER[key] ?? 0);
    if (effective > PLUGIN_MAX_TIER) return DENY;
    if (!this.#trustOk(rule, identity)) return DENY;
    if (rule.trust !== "none" && typeof identity.hostWindowId === "string" && this.#trust.isRevoked({ windowId: identity.hostWindowId, workspaceId: projectId })) return DENY;
    return effective > tier ? { effect: "allow", tier: effective } : { effect: "allow" };
  }

  // `project` and `per-start`: the gate decides in the handler (and re-reads the revoke there); here only a recorded revoke
  // refuses early. `identity.trusted` is never read. Any other mode fails closed.
  #trustOk(rule: Rule, identity: PolicyInput["identity"]): boolean {
    if (rule.trust === "none") return true;
    if (rule.trust !== "project" && rule.trust !== "per-start") return false;
    const { windowId, workspaceId } = identity;
    return !this.#trust.isRevoked({ windowId, ...(workspaceId === undefined ? {} : { workspaceId }) });
  }
}

/** True when a web client may call `key`: listed, not per-start, at most `WEB_MAX_TIER` and a read. */
function webAllowed(rule: Rule, key: string, tier: number, sideEffect: unknown): boolean {
  return WEB_ALLOWED.has(key) && rule.trust !== "per-start" && Math.max(rule.tier, tier) <= WEB_MAX_TIER && (sideEffect === "read" || sideEffect === "none");
}
