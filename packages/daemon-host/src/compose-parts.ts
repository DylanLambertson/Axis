// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { basename, normalize } from "node:path";
import { randomBytes } from "node:crypto";
import { AxisError, type AuditLog } from "@axis/audit";
import type { DaemonAuditSink } from "@axis/daemon";
import type { Journal } from "@axis/journal";
import type { RunsBindingDeps } from "./bindings/runs.js";
import type { ControlClient } from "./control/client.js";
import type { HandlerRegistrar } from "./handlers/anchor-guard.js";
import type { Logger } from "./log/logger.js";
import type { Clock } from "./ports/clock.js";
import type { RunsService } from "./ports/runs.js";

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

const NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,62}$/;

/** A display name for a project from its folder name; a name that is not plain text becomes a fixed word. */
export function projectDisplayName(path: string): string {
  const base = basename(path);
  return NAME.test(base) ? base : "project";
}

type ProjectsRegister = Parameters<Parameters<ControlClient["onProjectsRegister"]>[0]>[0];

/**
 * `projects.register` of the control channel (design 7.4 and question 4: main only). The id is generated here, the path is
 * main's and must already be normalised (the journal checks it), and the answer is the project id or a closed code: whatever
 * the journal said is never forwarded. `journal` is `undefined` when degraded (nothing may write).
 */
export function handleProjectsRegister(
  deps: { readonly journal: Pick<Journal, "registerProject"> | undefined; readonly control: Pick<ControlClient, "send">; readonly logger?: Logger },
  message: ProjectsRegister,
): void {
  const reply = (body: { ok: true; projectId: string } | { ok: false; code: "E_UNAVAILABLE" | "E_CONFLICT" | "E_INVALID_ARGUMENT" | "E_INTERNAL" }): void => {
    try {
      deps.control.send({ type: "projects.result", requestId: message.requestId, ...body });
    } catch {
      // the channel is gone; nothing to answer
    }
  };
  if (deps.journal === undefined) return reply({ ok: false, code: "E_UNAVAILABLE" });
  if (normalize(message.path) !== message.path) return reply({ ok: false, code: "E_INVALID_ARGUMENT" });
  const id = `p-${randomBytes(9).toString("hex")}`;
  try {
    const project = deps.journal.registerProject({ id, path: message.path, displayName: projectDisplayName(message.path), trusted: message.trusted, actor: "daemon" });
    reply({ ok: true, projectId: project.id });
  } catch (e) {
    const code = e instanceof AxisError && (e.code === "E_CONFLICT" || e.code === "E_INVALID_ARGUMENT") ? e.code : "E_INTERNAL";
    deps.logger?.warn("request.failed", { reason: "project_register", code });
    reply({ ok: false, code });
  }
}
