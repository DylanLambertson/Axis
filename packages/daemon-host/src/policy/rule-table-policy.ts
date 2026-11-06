// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { Policy, PolicyDecision, PolicyInput } from "@axis/daemon";
import type { TrustRegistry } from "../ports/trust.js";
import { RULES } from "./rules.js";
import { ruleKey, type Rule } from "./rule-types.js";

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
export class RuleTablePolicy implements Policy {
  readonly #rules: ReadonlyMap<string, Rule>;
  readonly #trust: TrustRegistry;

  constructor(trust: TrustRegistry, rules: Readonly<Record<string, Rule>> = RULES) {
    this.#trust = trust;
    this.#rules = new Map(Object.entries(rules));
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
    if (!rule.actors.some((a) => a === identity.actor)) return DENY;
    if (identity.clientKind === "desktop" ? identity.windowId === WEB_WINDOW_ID : !webAllowed(rule, key, tier, sideEffect)) return DENY;
    if (!this.#trustOk(rule, identity)) return DENY;
    return rule.tier > tier ? { effect: "allow", tier: rule.tier } : { effect: "allow" };
  }

  #trustOk(rule: Rule, identity: PolicyInput["identity"]): boolean {
    if (rule.trust === "none") return true;
    const { windowId, workspaceId, trusted } = identity;
    const subject = { windowId, ...(workspaceId === undefined ? {} : { workspaceId }) };
    if (rule.trust === "per-start") return !this.#trust.isRevoked(subject);
    return trusted === true && this.#trust.isTrusted(subject);
  }
}

/** True when a web client may call `key`: listed, not per-start, at most `WEB_MAX_TIER` and a read. */
function webAllowed(rule: Rule, key: string, tier: number, sideEffect: unknown): boolean {
  return WEB_ALLOWED.has(key) && rule.trust !== "per-start" && Math.max(rule.tier, tier) <= WEB_MAX_TIER && (sideEffect === "read" || sideEffect === "none");
}
