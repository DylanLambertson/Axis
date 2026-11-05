// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { APPROVALS_CONTRACT, APPROVALS_VERSION, approvalsMethods } from "./approvals.js";
import { permissionTierSchema } from "./challenge.js";
import { AUDIT_CONTRACT, AUDIT_VERSION, auditMethods } from "./audit.js";
import { CLI_RUNS_CONTRACT, CLI_RUNS_VERSION, cliRunsMethods } from "./cliRuns.js";
import { MAX_TIMEOUT_MS, methodNameSchema } from "./envelope.js";
import { PROJECTS_CONTRACT, PROJECTS_VERSION, projectsMethods } from "./projects.js";
import { PROVIDERS_CONTRACT, PROVIDERS_VERSION, providersMethods } from "./providers.js";
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
  if (typeof spec !== "object" || spec === null) return "spec is not an object";
  const s = spec as Partial<Record<keyof MethodSpec, unknown>>;
  const tier = permissionTierSchema.safeParse(s.tier);
  if (!tier.success) return "tier is not an integer from 0 to 5";
  if (!SIDE_EFFECTS.has(s.sideEffect)) return "unknown side effect";
  if (!IDEMPOTENCY.has(s.idempotency)) return "unknown idempotency mode";
  if (typeof s.timeoutMs !== "number" || !Number.isInteger(s.timeoutMs) || s.timeoutMs < 1 || s.timeoutMs > MAX_TIMEOUT_MS) {
    return "timeout is not an integer from 1 to the ceiling";
  }
  for (const part of [s.request, s.response]) {
    if (typeof (part as { safeParse?: unknown } | null)?.safeParse !== "function") return "missing request or response schema";
  }
  const t = tier.data;
  if ((s.sideEffect === "none" || s.sideEffect === "read") && t > 1) return "a read method is above tier 1";
  if ((s.sideEffect === "destructive" || s.sideEffect === "network" || s.sideEffect === "credential") && t < 3) {
    return "a destructive, network or credential method is below tier 3";
  }
  if (t >= 3 && !declaresApproval(spec as MethodSpec)) return "tier 3 or above without an optional approval field";
  return null;
}

/** Every problem in a contract table, as `<contract>/<major>.<method>: <reason>`. Empty when the table can be served. */
export function tableProblems(table: Table): string[] {
  const out: string[] = [];
  for (const key of Object.keys(table)) {
    const at = key.lastIndexOf("/");
    const id = key.slice(0, at);
    const version = Number(key.slice(at + 1));
    if (!contractIdSchema.safeParse(id).success || !contractVersionSchema.safeParse(version).success) {
      out.push(`${key}: not a valid contract key`);
    }
    const methods = table[key] ?? {};
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
 * rejects is treated as absent, so a bad tier can never be served.
 */
export function lookupMethodIn(table: Table, contract: string, version: number, method: string): MethodSpec | undefined {
  // The key is built by concatenation, so anything but a string and a safe integer could name another entry.
  if (typeof contract !== "string" || typeof method !== "string" || !Number.isSafeInteger(version)) return undefined;
  const key = `${contract}/${version}`;
  const methods = Object.hasOwn(table, key) ? table[key] : undefined;
  if (methods === undefined || !Object.hasOwn(methods, method)) return undefined;
  const spec = methods[method];
  return spec !== undefined && specProblem(spec) === null ? spec : undefined;
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
