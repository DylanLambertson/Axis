// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { AxisError, type AuditLog, type Redactor } from "@axis/audit";
import { providerRedactor } from "./bindings/provider-redactor.js";
import { protocolRegistry, type ContractRegistry, type DaemonAuditSink } from "@axis/daemon";
import { lookupMethod } from "@axis/protocol";
import type { HostServices } from "./host.js";
import type { Journal } from "@axis/journal";
import type { RunsBindingDeps } from "./bindings/runs.js";
import type { HandlerRegistrar } from "./handlers/anchor-guard.js";
import type { Clock } from "./ports/clock.js";
import type { RunsService } from "./ports/runs.js";
import type { ProjectMutex } from "./worktrees/project-mutex.js";
import type { MockProviderOptions, RunBudgetLimits } from "@axis/providers";
import type { CommandLimits } from "./bindings/agent-command.js";
import type { ToolCaps } from "./composer/loop.js";
import type { PtyPort } from "./ports/pty.js";

/**
 * Small pieces of the composition root (ticket H12), kept apart so `compose.ts` stays readable. None of them touches a
 * package other than the host's own bindings and ports.
 */

/**
 * The cycle breaker of design question 19. The worktrees binding needs `runs.hasActiveRun` and the runs binding needs the
 * worktrees binding's locator and mutex, so the worktrees binding is built first with this forwarder. Until the runs
 * binding is bound the forwarder answers `true` (a run may be active), never `false`: a refusal that waits is safe, an
 * answer of "no run" that nothing has checked is not. A service that throws counts as active too (fail closed).
 */
export interface ActiveRunForwarder {
  readonly hasActiveRun: (workspaceId: string) => boolean;
  /** Bind the real service. Once; a second bind is refused (the answer must not be switched back and forth). */
  readonly bind: (service: Pick<RunsService, "hasActiveRun">) => void;
}

/**
 * The composer's write lock (policies 3.3 and 6.1, ticket C2): the project mutex of the workspace's project, the one Axis
 * commit and push take, queued as an unrelated caller (`exclusive`: the loop runs in the async context of the `start`
 * that held the mutex long ago). A workspace the journal does not know is refused, so the write does not happen.
 */
export function composerWriteLock(journal: Pick<Journal, "getWorkspace">, mutex: Pick<ProjectMutex, "exclusive">) {
  return <T>(workspaceId: string, fn: () => Promise<T>, signal: AbortSignal): Promise<T> => {
    const ws = journal.getWorkspace(workspaceId);
    if (ws === undefined) return Promise.reject(new AxisError("E_NOT_FOUND", "The workspace is not known", { reason: "unknown_workspace" }));
    return mutex.exclusive(ws.projectId, fn, signal);
  };
}

export function createActiveRunForwarder(): ActiveRunForwarder {
  let bound: Pick<RunsService, "hasActiveRun"> | undefined;
  return {
    hasActiveRun(workspaceId) {
      if (bound === undefined) return true;
      try {
        return bound.hasActiveRun(workspaceId) !== false;
      } catch {
        return true;
      }
    },
    bind(service) {
      if (bound !== undefined) throw new AxisError("E_CONFLICT", "The runs service is already bound", { reason: "already_bound" });
      bound = service;
    },
  };
}

/** The run supervisor's clock: wall time for stamps, unref'd timers for the stop ladder (a timer never keeps the process alive). */
export function createRunsClock(clock: Pick<Clock, "now">): RunsBindingDeps["clock"] {
  return {
    now: () => clock.now(),
    setTimeout: (fn, ms) => {
      const t = setTimeout(fn, ms) as unknown as NodeJS.Timeout; // opaque handle under Code OSS's typings (ADR 0005)
      t.unref();
      return t;
    },
    clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  };
}

/** Records every `<contract>/<version>.<method>` handed to the real registrar, so the composition can compare it with what is served. */
export function recordingRegistrar(inner: HandlerRegistrar): { readonly registrar: HandlerRegistrar; readonly methods: () => ReadonlySet<string> } {
  const seen = new Set<string>();
  const register: HandlerRegistrar["register"] = (contract, version, handlers, options) => {
    for (const method of Object.keys(handlers)) seen.add(`${contract}/${version}.${method}`);
    inner.register(contract, version, handlers, options);
  };
  const registrar: HandlerRegistrar = Object.freeze({ register });
  return { registrar, methods: () => new Set(seen) };
}

/**
 * The daemon's own decision and execution rows go to the audit log. A write notifies the anchor manager (design 5.4). In degraded
 * mode there is no writer and only read methods are served, so the sink accepts and drops: a request that cannot be recorded
 * must not hide the audit that explains why the host is degraded.
 */
export function daemonAuditSink(audit: Pick<AuditLog, "append"> | undefined, noteWrite: () => void): DaemonAuditSink {
  if (audit === undefined) return { append: () => undefined };
  return {
    append(event) {
      audit.append(event);
      noteWrite();
    },
  };
}

/**
 * A switch that closes the composer's audit writers for good (review r1 S1): once the final anchor is being taken, a late
 * `broker.decision`, `broker.result` or challenge row must not land after it. `guard()` throws `E_UNAVAILABLE`
 * (`audit_sealed`) after `seal()`, so the broker fails the call closed (`audit-failed`) and the loop stops; nothing is
 * written past the checkpoint.
 */
export interface AuditSeal {
  readonly guard: () => void;
  readonly seal: () => void;
  readonly sealed: () => boolean;
}

export function createAuditSeal(): AuditSeal {
  let closed = false;
  return Object.freeze({
    guard: () => {
      if (closed) throw new AxisError("E_UNAVAILABLE", "The audit log is closed for shutdown", { reason: "audit_sealed" });
    },
    seal: () => void (closed = true),
    sealed: () => closed,
  });
}

/**
 * Shutdown step 3 for composer runs (design 8; review r1 S1): stop every loop (the service then writes nothing to the
 * journal), give what was already running a bounded moment to record its result (a cancelled approval records its
 * withdrawal), then seal the audit writers, so the final checkpoint covers the last composer row. Resolves `true` when
 * every loop settled in time. The bounding timer is always cleared.
 */
export async function settleComposer(composer: { dispose(): void; idle(): Promise<void> } | undefined, seal: Pick<AuditSeal, "seal">, waitMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    if (composer === undefined) return true;
    composer.dispose();
    const late = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), waitMs) as unknown as NodeJS.Timeout; // opaque handle under Code OSS's typings (ADR 0005)
      timer.unref();
    });
    return await Promise.race([composer.idle().then(() => true as const, () => true as const), late]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    seal.seal();
  }
}

/** The registry restricted to what the host serves, so an unserved method does not exist (and `hello` does not offer it). */
export function registryOf(surface: HostServices["surface"]): ContractRegistry {
  return {
    lookup: (contract, version, method) => (surface.registry[`${contract}/${version}`]?.[method] === undefined ? undefined : lookupMethod(contract, version, method)),
    versions: (contract) => protocolRegistry.versions(contract).filter((v) => surface.registry[`${contract}/${v}`] !== undefined),
  };
}

/** Composer runs (`axis.runs/1`, docs/design/composer-runtime.md): the mock provider's script, budgets and bounds (the Anthropic connection is added in compose.ts, the only importer of the providers binding there). */
export interface ComposerOptions {
  readonly mock?: MockProviderOptions;
  readonly budget?: RunBudgetLimits;
  /** Per-workspace budget across composer runs (C10); default `DEFAULT_WORKSPACE_BUDGET`. */
  readonly workspaceBudget?: RunBudgetLimits;
  readonly maxTurns?: number;
  readonly toolCaps?: Partial<ToolCaps>;
  /**
   * Lower the `run_command` bounds (C3), never raise them: each given bound a positive integer at or below its
   * `DEFAULT_COMMAND_LIMITS` value, no other key (`hostCommandLimits`); anything else refuses the composition
   * (`command_limits_invalid`).
   */
  readonly commandLimits?: Partial<CommandLimits>;
}

export function refuseComposition(reason: string): never {
  throw new AxisError("E_INVALID_ARGUMENT", "The host composition is incomplete", { reason });
}

export const isPty = (p: unknown): p is PtyPort => typeof (p as { spawn?: unknown } | null)?.spawn === "function";

/**
 * The host redactor's secret check for message deliveries (messages-contract.md section 11): the providers' own check
 * (windowed, so a long body is judged whole), so a body it matches is withheld before the providers would refuse it.
 */
export function messageSecretCheck(redactor: Redactor): (text: string) => boolean {
  const check = providerRedactor(redactor);
  return (text) => check.containsSecret(text);
}
