// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { APPROVALS_CONTRACT, APPROVALS_VERSION, approvalsMethods } from "./approvals.js";
import { permissionTierSchema } from "./challenge.js";
import { AUDIT_CONTRACT, AUDIT_VERSION, auditMethods } from "./audit.js";
import { CLI_RUNS_CONTRACT, CLI_RUNS_VERSION, cliRunsMethods } from "./cliRuns.js";
import { COMPOSER_RUNS_CONTRACT, COMPOSER_RUNS_VERSION, composerRunsMethods } from "./composer-runs.js";
import { EVENTS_CONTRACT, EVENTS_VERSION, eventsMethods } from "./events.js";
import { GIT_CONTRACT, GIT_VERSION, gitMethods } from "./git.js";
import { MAX_TIMEOUT_MS, methodNameSchema } from "./envelope.js";
import { PROJECTS_CONTRACT, PROJECTS_VERSION, projectsMethods } from "./projects.js";
import { PROVIDERS_CONTRACT, PROVIDERS_VERSION, providersMethods } from "./providers.js";
import { REVIEW_CONTRACT, REVIEW_VERSION, reviewMethods } from "./review.js";
import { contractIdSchema, contractVersionSchema } from "./version.js";
import { WORKTREES_CONTRACT, WORKTREES_VERSION, worktreesMethods, type MethodSpec } from "./worktrees.js";

type Table = Readonly<Record<string, Readonly<Record<string, MethodSpec>>>>;

/** Freeze a method table and every spec in it, so no caller can lower a tier at run time. */
function frozen<T extends Readonly<Record<string, MethodSpec>>>(methods: T): T {
  for (const spec of Object.values(methods)) Object.freeze(spec);
  return Object.freeze(methods);
}

/** Every contract this build serves, keyed `<id>/<major>`. */
export const contracts: Table = Object.freeze({
  [`${WORKTREES_CONTRACT}/${WORKTREES_VERSION}`]: frozen(worktreesMethods),
  [`${PROJECTS_CONTRACT}/${PROJECTS_VERSION}`]: frozen(projectsMethods),
  [`${APPROVALS_CONTRACT}/${APPROVALS_VERSION}`]: frozen(approvalsMethods),
  [`${AUDIT_CONTRACT}/${AUDIT_VERSION}`]: frozen(auditMethods),
  [`${CLI_RUNS_CONTRACT}/${CLI_RUNS_VERSION}`]: frozen(cliRunsMethods),
  [`${PROVIDERS_CONTRACT}/${PROVIDERS_VERSION}`]: frozen(providersMethods),
  [`${GIT_CONTRACT}/${GIT_VERSION}`]: frozen(gitMethods),
  [`${REVIEW_CONTRACT}/${REVIEW_VERSION}`]: frozen(reviewMethods),
  [`${COMPOSER_RUNS_CONTRACT}/${COMPOSER_RUNS_VERSION}`]: frozen(composerRunsMethods),
  [`${EVENTS_CONTRACT}/${EVENTS_VERSION}`]: frozen(eventsMethods),
});

const SIDE_EFFECTS: ReadonlySet<unknown> = new Set(["none", "read", "write", "network", "destructive", "credential"]);
const IDEMPOTENCY: ReadonlySet<unknown> = new Set(["none", "optional", "required"]);

/** Does the request schema declare an optional `approval` (what a tier 3 and above method must)? */
function declaresApproval(spec: MethodSpec): boolean {
  const field = (spec.request as { shape?: Record<string, { safeParse(v: unknown): { success: boolean } }> }).shape?.["approval"];
  return (
    field !== undefined &&
    field.safeParse(undefined).success &&
    field.safeParse({ challengeId: "A".repeat(43) }).success
  );
}

/**
 * Why a method spec cannot be served, or null. Fails closed on: a tier that
 * is not an integer from 0 to 5 (NaN, a string, a float, undefined); a side
 * effect or idempotency mode outside the closed sets; a timeout outside
 * 1..MAX_TIMEOUT_MS; request or response without `safeParse`; a read above
 * tier 1; a destructive, network or credential method below tier 3; and a
 * tier 3 or above method that cannot take an optional `approval`.
 */
export function specProblem(spec: unknown): string | null {
  const f = dataFields(spec);
  if (f === null) return "spec is not an object whose fields are plain data properties";
  const tier = permissionTierSchema.safeParse(f.tier);
  if (!tier.success) return "tier is not an integer from 0 to 5";
  if (!SIDE_EFFECTS.has(f.sideEffect)) return "unknown side effect";
  if (!IDEMPOTENCY.has(f.idempotency)) return "unknown idempotency mode";
  if (typeof f.timeoutMs !== "number" || !Number.isInteger(f.timeoutMs) || f.timeoutMs < 1 || f.timeoutMs > MAX_TIMEOUT_MS) {
    return "timeout is not an integer from 1 to the ceiling";
  }
  for (const part of [f.request, f.response]) {
    if (typeof (part as { safeParse?: unknown } | null)?.safeParse !== "function") return "missing request or response schema";
  }
  const t = tier.data;
  if ((f.sideEffect === "none" || f.sideEffect === "read") && t > 1) return "a read method is above tier 1";
  if ((f.sideEffect === "destructive" || f.sideEffect === "network" || f.sideEffect === "credential") && t < 3) {
    return "a destructive, network or credential method is below tier 3";
  }
  if (t >= 3 && !declaresApproval(f as unknown as MethodSpec)) return "tier 3 or above without an optional approval field";
  return null;
}

const SPEC_FIELDS = ["tier", "sideEffect", "idempotency", "timeoutMs", "request", "response"] as const;

/** The six fields of a spec read as own data properties (never through an accessor or a Proxy trap), or null. */
function dataFields(spec: unknown): Record<(typeof SPEC_FIELDS)[number], unknown> | null {
  if (typeof spec !== "object" || spec === null) return null;
  try {
    const out: Record<string, unknown> = {};
    for (const k of SPEC_FIELDS) {
      const d = Object.getOwnPropertyDescriptor(spec, k);
      if (d === undefined || !("value" in d)) return null;
      out[k] = d.value;
    }
    return out as Record<(typeof SPEC_FIELDS)[number], unknown>;
  } catch {
    return null;
  }
}

/** Every problem in a contract table, as `<contract>/<major>.<method>: <reason>`. Empty when the table can be served. */
export function tableProblems(table: Table): string[] {
  const out: string[] = [];
  for (const key of Object.keys(table)) {
    const at = key.lastIndexOf("/");
    const id = key.slice(0, at);
    const version = Number(key.slice(at + 1));
    // The key must be exactly what a lookup builds, so no entry can be unreachable (`axis.x/01`, `axis.x/1e0`).
    if (!contractIdSchema.safeParse(id).success || !contractVersionSchema.safeParse(version).success || `${id}/${version}` !== key) {
      out.push(`${key}: not a valid contract key`);
    }
    const methods = table[key];
    if (typeof methods !== "object" || methods === null) {
      out.push(`${key}: not a method table`);
      continue;
    }
    for (const name of Object.keys(methods)) {
      if (!methodNameSchema.safeParse(name).success) out.push(`${key}.${name}: not a valid method name`);
      const problem = specProblem(methods[name]);
      if (problem !== null) out.push(`${key}.${name}: ${problem}`);
    }
  }
  return out;
}

/**
 * The method's spec in `table`, or undefined (the daemon answers
 * E_METHOD_NOT_FOUND). Only own entries count, and a spec that `specProblem`
 * rejects is treated as absent, so a bad tier can never be served. The
 * fields are read once, as data properties: an accessor (a tier that is valid
 * during the check and NaN after it) fails the check, and a spec that is not
 * frozen is served as a frozen copy of what was checked.
 */
export function lookupMethodIn(table: Table, contract: string, version: number, method: string): MethodSpec | undefined {
  // The key is built by concatenation, so anything but a string and a safe integer could name another entry.
  if (typeof contract !== "string" || typeof method !== "string" || !Number.isSafeInteger(version)) return undefined;
  const key = `${contract}/${version}`;
  const methods = Object.hasOwn(table, key) ? table[key] : undefined;
  if (methods === undefined || !Object.hasOwn(methods, method)) return undefined;
  const spec = methods[method];
  if (spec === undefined || specProblem(spec) !== null) return undefined;
  // Every field is a data property, so a frozen spec cannot change after the check; anything else is served as a frozen copy.
  return Object.isFrozen(spec) ? spec : Object.freeze(dataFields(spec) as unknown as MethodSpec);
}

/** The method's spec, or undefined (the daemon answers E_METHOD_NOT_FOUND). */
export function lookupMethod(contract: string, version: number, method: string): MethodSpec | undefined {
  return lookupMethodIn(contracts, contract, version, method);
}

/**
 * The envelope marks `idempotencyKey` optional because the requirement is
 * per method. The daemon MUST refuse a request without one when this returns
 * true (E_INVALID_ARGUMENT); nothing in the schema enforces it.
 */
export function requiresIdempotencyKey(contract: string, version: number, method: string): boolean {
  return lookupMethod(contract, version, method)?.idempotency === "required";
}
