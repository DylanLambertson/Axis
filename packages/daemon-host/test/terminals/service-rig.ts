// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// TEST ONLY: the DC-3a terminal service over fakes: a journal of one project and its workspaces, a locator and binding that a test
// can change between awaits, a trust gate that mints real tickets and can run a hook inside its await, and a fake terminal port.
import type { AuditEventInput } from "@axis/audit";
import type { HandlerContext } from "@axis/daemon";
import type { Project, Workspace } from "@axis/journal";
import { mintTicket } from "../../src/gate/project-ticket.js";
import type { ProjectTrustGate } from "../../src/gate/project-trust.js";
import { InMemoryTrustRegistry } from "../../src/policy/trust-registry.js";
import { ProjectMutex } from "../../src/worktrees/project-mutex.js";
import { TerminalRegistry } from "../../src/terminals/registry.js";
import type { TerminalServiceDeps } from "../../src/terminals/service.js";
import { FakeTerminalPort } from "./fakes.js";

export const WT = "/root/worktrees/ws1";

export function serviceRig(over: Partial<TerminalServiceDeps> = {}) {
  let clock = 1000;
  const projects = new Map<string, Project>([["p1", { id: "p1", path: "/repo", displayName: "r", trusted: true, commonDir: "/repo/.git", gitDirId: "1:2", trustChangedAt: null, createdAt: "t", updatedAt: "t" }]]);
  const workspaces = new Map<string, Workspace>([["ws1", { id: "ws1", projectId: "p1", state: "READY", worktreePath: WT, lockState: "unlocked", lockedAt: null } as unknown as Workspace]]);
  const port = new FakeTerminalPort();
  const registry = new TerminalRegistry({ port });
  const trust = new InMemoryTrustRegistry();
  const audits: AuditEventInput[] = [];
  const tickets: unknown[] = [];
  /** Run inside the gate's await (after its checks, before it returns), and inside each locate, by call number. */
  const hooks = { inGate: undefined as (() => void) | undefined, inLocate: undefined as ((n: number) => void) | undefined, belongs: true, inBelongs: undefined as (() => void) | undefined, locateFails: undefined as ((n: number) => boolean) | undefined, gateRefuses: false };
  let locates = 0;
  const gate: ProjectTrustGate = {
    async admit({ projectId, workspaceId, signal }) {
      if (hooks.gateRefuses || projects.get(projectId)?.trusted !== true) throw Object.assign(new Error("The project is not trusted"), { code: "E_POLICY_DENIED" });
      await Promise.resolve();
      hooks.inGate?.();
      signal.throwIfAborted();
      const t = mintTicket(projectId, workspaceId, clock);
      tickets.push(t);
      return t;
    },
  };
  const deps: TerminalServiceDeps = {
    registry,
    port,
    journal: { getWorkspace: (id: string) => workspaces.get(id), getProject: (id: string) => projects.get(id) } as TerminalServiceDeps["journal"],
    locator: {
      async locate(id: string) {
        const n = ++locates;
        await Promise.resolve();
        hooks.inLocate?.(n);
        const ws = workspaces.get(id);
        if (ws === undefined || ws.worktreePath === null || hooks.locateFails?.(n) === true) throw Object.assign(new Error("not found"), { code: "E_NOT_FOUND" });
        return { workTree: ws.worktreePath, gitDir: "/repo/.git/worktrees/ws1" };
      },
    },
    belongs: async () => {
      await Promise.resolve();
      hooks.inBelongs?.();
      return hooks.belongs;
    },
    gate,
    trust,
    mutex: new ProjectMutex(),
    shell: async () => "/bin/zsh",
    env: () => ({ PATH: "/usr/bin", SSH_AUTH_SOCK: "/run/agent" }),
    now: () => clock,
    audit: (e) => void audits.push(e),
    ...over,
  };
  const ctl = new AbortController();
  const context = (signal: AbortSignal = ctl.signal): HandlerContext =>
    ({ identity: { windowId: "w1", clientKind: "desktop", actor: "user", actorId: "user", connectionId: "c", trusted: true }, requestId: "r", correlationId: "c", idempotencyKey: "k", signal }) as unknown as HandlerContext;
  return { deps, port, registry, trust, projects, workspaces, audits, tickets, hooks, context, ctl, tick: (ms: number) => (clock += ms) };
}
