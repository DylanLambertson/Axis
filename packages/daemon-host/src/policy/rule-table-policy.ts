// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { Policy, PolicyDecision, PolicyInput } from "@axis/daemon";
import type { TrustRegistry } from "../ports/trust.js";
import { RULES } from "./rules.js";
import { ruleKey, type Rule } from "./rule-types.js";

const DENY: PolicyDecision = Object.freeze({ effect: "deny" });

/**
 * What a web client (`clientKind: "web"`, minted only by the web host entry, `docs/design/web-host-entry.md` W-5) may
 * call until a web approval and trust surface exists (Phase 2): reads only. Nothing above tier 1, no per-start trust
 * (a CLI run start), and nothing of `axis.approvals` (a web client must not list or resolve a challenge, and every web
 * tab shares one window). Fails closed for anything not listed.
 */
export const WEB_MAX_TIER = 1;
export const WEB_DENIED_CONTRACTS: ReadonlySet<string> = new Set(["axis.approvals"]);

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
    const { identity, contract, version, method, tier } = input; // each field is read exactly once
    if (typeof contract !== "string" || typeof method !== "string" || !Number.isInteger(version)) return DENY;
    if (!Number.isInteger(tier) || tier < 0 || tier > 5) return DENY;
    const rule = this.#rules.get(ruleKey(contract, version, method));
    if (rule === undefined) return DENY;
    if (typeof identity !== "object" || identity === null) return DENY;
    if (!rule.actors.some((a) => a === identity.actor)) return DENY;
    if (identity.clientKind !== "desktop" && !webAllowed(rule, contract, tier)) return DENY;
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

/** True when a web client may call a method with this rule (see `WEB_MAX_TIER`). */
function webAllowed(rule: Rule, contract: string, tier: number): boolean {
  return Math.max(rule.tier, tier) <= WEB_MAX_TIER && rule.trust !== "per-start" && !WEB_DENIED_CONTRACTS.has(contract);
}
