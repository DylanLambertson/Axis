// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { Policy, PolicyDecision, PolicyInput } from "@axis/daemon";
import type { TrustRegistry } from "../ports/trust.js";
import { RULES } from "./rules.js";
import { ruleKey, type Rule } from "./rule-types.js";

const DENY: PolicyDecision = Object.freeze({ effect: "deny" });

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
