// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { createHash } from "node:crypto";
import { z } from "zod";
import { Redactor, canonicalize, type AuditActor, type AuditSink } from "@axis/audit";
import { resolveExecutable, nodeFs } from "@axis/pty-policy";
import type { GitRunResult, GitRunner } from "@axis/git-ops";
import { BrokerAudit, BROKER_ACTIONS } from "./audit.js";
import { foldName } from "./lexical.js";
import { isUnder, readContained, resolveRoot, resolveTarget, writeContained, type ContainDeps, type TargetGuard } from "./contain.js";
import { buildToolEnv, type EnvGrantSource } from "./env.js";
import { BrokerError, denied, invalid, toBrokerError } from "./errors.js";
import type { BrokerFs } from "./fs.js";
import { createBrokerGit, type BrokerGit, type GitCall } from "./git.js";
import { ApprovalLedger, ToolPolicy, verifyApproval, type ApprovalHook, type PolicyOptions, type VerifiedApproval } from "./policy.js";
import type { CommandRunner, RunRecord } from "./runner.js";
import { parseTier, type Clock, type Env, type Tier, type ToolTarget, type WorktreeRegistry } from "./types.js";
import type { WorktreeRef } from "@axis/git-ops";

const ACTOR = /^(?:user|daemon|agent:[A-Za-z0-9._-]{1,64})$/;
const TOOL_NAME = /^[a-z][a-z0-9_.-]{0,63}$/;
const MAX_TARGETS = 32;
const PREVIEW_CHARS = 4096;

/** What a tool's action may do. Every call re-resolves its path at the time of use (WT-1). */
export interface ToolContext {
  readonly worktreeId: string;
  readonly signal: AbortSignal;
  readFile(path: string, maxBytes: number): Promise<Buffer>;
  writeFile(path: string, data: Uint8Array, o: { readonly mode: "overwrite" | "create" | "upsert"; readonly maxBytes: number }): Promise<void>;
  /** `command` is a bare name (resolved on PATH outside the worktree) or an absolute path. No shell. */
  run(o: { readonly command: string; readonly args?: readonly string[]; readonly cwd?: string; readonly timeoutMs: number; readonly maxOutputBytes: number; readonly stdin?: Uint8Array }): Promise<RunRecord>;
  git(call: GitCall): Promise<GitRunResult>;
}

export interface ToolDefinition<A = unknown> {
  readonly name: string;
  readonly tier: Tier;
  /** Strict schema for the model's arguments (ANT-2). */
  readonly args: z.ZodType<A>;
  /** The paths the call touches, for containment and protected-path policy. */
  readonly targets?: (args: A) => readonly ToolTarget[];
  /** `argv[0]` of a command the call will start, for the launcher rule. */
  readonly command?: (args: A) => string | undefined;
  /** A tier computed from the arguments, such as `gitCallTier`. Only raises. */
  readonly raise?: (args: A) => Tier | undefined;
  readonly envAdditions?: readonly string[];
  readonly envFixed?: Readonly<Record<string, string>>;
  readonly run: (ctx: ToolContext, args: A) => Promise<unknown>;
}

export interface ToolCall {
  readonly tool: string;
  readonly worktreeId: string;
  readonly actor: string;
  readonly args: unknown;
  readonly signal?: AbortSignal;
}

export interface BrokerDeps {
  readonly registry: WorktreeRegistry;
  readonly fs: BrokerFs;
  readonly audit: AuditSink;
  readonly runner: CommandRunner;
  readonly parentEnv: () => Env;
  readonly approval?: ApprovalHook;
  readonly grants?: EnvGrantSource;
  readonly redactor?: Redactor;
  /** Needed only for git tools. */
  readonly gitRunner?: GitRunner;
  readonly assertNoDrift?: (w: WorktreeRef) => Promise<void>;
  readonly clock?: Clock;
  readonly platform?: NodeJS.Platform;
  readonly policy?: PolicyOptions;
  readonly extraProtected?: readonly (readonly string[])[];
  readonly approvalTimeoutMs?: number;
  readonly maxApprovalTtlMs?: number;
}

/** What a call declared it touches, resolved when the policy decided. A use that resolves anywhere else is refused. */
interface Declared {
  readonly access: "read" | "write";
  readonly lex: string;
  readonly real: string;
}

const isAborted = (s: AbortSignal | undefined): boolean => s?.aborted === true;
const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);
const CTRL = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]", "g");
const printable = (s: string): string => clip(s.replace(CTRL, "?"), 200);
const sha = (t: string): string => createHash("sha256").update(t).digest("hex");

export class ToolBroker {
  readonly #d: BrokerDeps;
  readonly #tools = new Map<string, ToolDefinition>();
  readonly #policy: ToolPolicy;
  readonly #audit: BrokerAudit;
  readonly #ledger = new ApprovalLedger();
  readonly #contain: ContainDeps;
  readonly #git: BrokerGit | undefined;
  readonly #platform: NodeJS.Platform;
  readonly #now: () => number;
  readonly #redactor: Redactor;

  constructor(deps: BrokerDeps) {
    this.#d = deps;
    this.#platform = deps.platform ?? process.platform;
    this.#now = (): number => (deps.clock ?? { now: Date.now }).now();
    this.#policy = new ToolPolicy(deps.policy);
    this.#redactor = deps.redactor ?? new Redactor();
    this.#audit = new BrokerAudit(deps.audit, this.#redactor);
    this.#contain = {
      registry: deps.registry, fs: deps.fs, platform: this.#platform,
      ...(deps.extraProtected === undefined ? {} : { extraProtected: deps.extraProtected }),
    };
    this.#git = deps.gitRunner === undefined || deps.assertNoDrift === undefined
      ? undefined
      : createBrokerGit({ runner: deps.gitRunner, parentEnv: deps.parentEnv(), assertNoDrift: deps.assertNoDrift, platform: this.#platform });
  }

  /** A tool with an invalid name or tier is refused here, not at call time. */
  register<A>(def: ToolDefinition<A>): void {
    if (typeof def?.name !== "string" || !TOOL_NAME.test(def.name) || this.#tools.has(def.name)) throw invalid("invalid-call", "the tool name is not valid");
    if (parseTier(def.tier) === undefined) throw denied("invalid-tier", "the tool tier is not valid");
    // A command can leave its process group (setsid), so the approval floor is the only gate for it (PTY-4 residual).
    if (def.command !== undefined && !this.#policy.needsApproval(def.tier)) {
      throw denied("invalid-tier", "a tool that starts a command must sit at or above the approval floor");
    }
    this.#tools.set(def.name, Object.freeze({ ...def }) as ToolDefinition);
  }

  async invoke(call: ToolCall): Promise<unknown> {
    const started = performance.now();
    // Every field is read exactly once, here: a getter cannot show the validation one value and the audit another.
    let tool0: unknown, wt0: unknown, actor0: unknown, args0: unknown, signal0: unknown;
    try {
      if (call === null || typeof call !== "object") throw new Error("shape");
      ({ tool: tool0, worktreeId: wt0, actor: actor0, args: args0, signal: signal0 } = call);
    } catch {
      throw invalid("invalid-call", "the call is not valid");
    }
    if (typeof actor0 !== "string" || !ACTOR.test(actor0) || (signal0 !== undefined && !(signal0 instanceof AbortSignal))) {
      throw invalid("invalid-call", "the call is not valid");
    }
    const actor = actor0 as AuditActor;
    const signal = signal0 as AbortSignal | undefined;
    const worktreeId = typeof wt0 === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(wt0) ? wt0 : "invalid";
    const target = `worktree:${worktreeId}`;
    const toolName = typeof tool0 === "string" ? printable(tool0) : "invalid";
    const refuse = (e: BrokerError, extra: Record<string, string | number | boolean | null> = {}): never => {
      this.#audit.record({ actor, action: BROKER_ACTIONS.decision, target, outcome: "denied", payload: { tool: toolName, decision: "deny", reason: e.reason, ...extra } });
      throw e;
    };
    if (worktreeId === "invalid") return refuse(invalid("invalid-call", "the call is not valid"));
    if (signal?.aborted === true) return refuse(new BrokerError("E_CANCELLED", "aborted", "the call was cancelled"));
    const tool = typeof tool0 === "string" ? this.#tools.get(tool0) : undefined;
    if (tool === undefined) return refuse(denied("unknown-tool", "the tool is not registered"));

    const parsed = tool.args.safeParse(args0);
    if (!parsed.success) return refuse(invalid("invalid-args", "the arguments are not valid"), { tier: tool.tier });
    const args = parsed.data;

    // Containment and protected paths, resolved now for the policy and again when the action uses them.
    const rels: string[] = [];
    const ops: { access: "read" | "write"; path: string }[] = [];
    const declared: Declared[] = [];
    const labels: string[] = [];
    let protectedHit = false;
    try {
      const targets = tool.targets?.(args) ?? [];
      if (targets.length > MAX_TARGETS) throw invalid("invalid-args", "too many paths");
      for (const t of targets) {
        const mode = t.access === "read" ? "read" : "upsert";
        const r = await resolveTarget(this.#contain, worktreeId, t.path, mode);
        rels.push(r.rel);
        ops.push({ access: t.access === "read" ? "read" : "write", path: r.rel });
        declared.push({ access: t.access === "read" ? "read" : "write", lex: this.#key(r.segments), real: this.#key(r.realSegments) });
        if (r.protected !== undefined && (t.access === "write" || r.protected.gitDir)) {
          protectedHit = true;
          labels.push(r.protected.label);
        }
      }
    } catch (e) {
      return refuse(toBrokerError(e), { tier: tool.tier });
    }

    let argv0: string | undefined;
    let raised: Tier | undefined;
    try {
      argv0 = tool.command?.(args);
      raised = tool.raise?.(args);
    } catch (e) {
      return refuse(toBrokerError(e), { tier: tool.tier });
    }
    const decision = this.#policy.decide({
      tool: tool.name, tier: tool.tier, protectedHit, protectedLabels: [...new Set(labels)],
      ...(argv0 === undefined ? {} : { argv0 }), ...(raised === undefined ? {} : { raisedTier: raised }),
    });
    if (decision.effect === "deny") return refuse(denied("invalid-tier", "the tool tier is not valid"));

    let digest: string;
    try {
      digest = sha(canonicalize({ tool: tool.name, worktreeId, actor, tier: decision.tier, paths: ops.map((o) => `${o.access}:${o.path}`), args: args as never }));
    } catch {
      return refuse(invalid("invalid-args", "the arguments cannot be approved"), { tier: decision.tier });
    }

    let approval: VerifiedApproval | undefined;
    if (decision.effect === "approve") {
      try {
        const preview = this.#redactor.redactString(canonicalize(args as never));
        approval = await this.#approve(signal, tool.name, decision.tier, decision.reasons, ops, preview, digest, worktreeId, actor);
      } catch (e) {
        return refuse(toBrokerError(e), { tier: decision.tier, digest, reasons: decision.reasons.join(",") });
      }
    }
    this.#audit.record({
      actor, action: BROKER_ACTIONS.decision, target, outcome: "success",
      payload: {
        tool: tool.name, tier: decision.tier, decision: approval === undefined ? "allow" : "approved", digest,
        reasons: decision.reasons.join(","), paths: clip(rels.join("\n"), 512), protected: protectedHit,
        ...(approval === undefined ? {} : { approvedBy: approval.approvedBy, approvalId: approval.approvalId, expiresAt: approval.expiresAt }),
      },
    });

    const stats = { bytesRead: 0, bytesWritten: 0, effects: 0, endedBy: null as string | null, exitCode: null as number | null, outputBytes: 0 };
    const ac = new AbortController();
    const onAbort = (): void => ac.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (isAborted(signal)) ac.abort();
    let result: unknown;
    let failure: BrokerError | undefined;
    try {
      // Cancelled between the decision and the action: nothing has run, so nothing runs.
      if (ac.signal.aborted) throw new BrokerError("E_CANCELLED", "aborted", "the call was cancelled");
      result = await tool.run(this.#context(worktreeId, tool, ac.signal, stats, declared), args);
    } catch (e) {
      failure = toBrokerError(e);
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
    try {
      this.#audit.record({
        actor, action: BROKER_ACTIONS.result, target, outcome: failure === undefined ? "success" : "error",
        payload: {
          tool: tool.name, digest, ok: failure === undefined, code: failure?.code ?? null, durationMs: Math.round(performance.now() - started),
          effects: stats.effects, bytesRead: stats.bytesRead, bytesWritten: stats.bytesWritten, endedBy: stats.endedBy, exitCode: stats.exitCode, outputBytes: stats.outputBytes,
        },
      });
    } catch (e) {
      // The action already ran: say so, so the caller does not retry a side effect.
      throw new BrokerError("E_INTERNAL", "audit-failed", "the audit event could not be written", { executed: true, ok: failure === undefined });
    }
    if (failure !== undefined) throw failure;
    return result;
  }

  async #approve(signal: AbortSignal | undefined, tool: string, tier: Tier, reasons: readonly string[], ops: readonly { access: "read" | "write"; path: string }[], preview: string, digest: string, worktreeId: string, actor: string): Promise<VerifiedApproval> {
    const hook = this.#d.approval;
    if (hook === undefined) throw denied("no-approval-hook", "the call needs approval and none is configured");
    const maxTtlMs = this.#d.maxApprovalTtlMs ?? 600_000;
    const timeoutMs = this.#d.approvalTimeoutMs ?? 120_000;
    if (!Number.isInteger(maxTtlMs) || maxTtlMs <= 0 || !Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
      throw denied("approval-error", "the approval limits are not valid");
    }
    const ac = new AbortController();
    const abort = (): void => ac.abort();
    signal?.addEventListener("abort", abort, { once: true });
    let timer: NodeJS.Timeout | undefined;
    try {
      if (signal?.aborted === true) throw new BrokerError("E_CANCELLED", "aborted", "the call was cancelled");
      // A hook that ignores its signal and answers "yes" after the call was cancelled must not start the action.
      const cancelled = new Promise<never>((_, reject) => {
        signal?.addEventListener("abort", () => reject(new BrokerError("E_CANCELLED", "aborted", "the call was cancelled")), { once: true });
      });
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          ac.abort();
          reject(new BrokerError("E_TIMEOUT", "approval-timeout", "the approval timed out"));
        }, timeoutMs);
      });
      const raw = await Promise.race([
        Promise.resolve().then(() => hook.request({
          digest, tool, tier, worktreeId, actor, reasons: [...reasons], targets: ops.slice(0, 16).map((o) => printable(o.path)), maxTtlMs,
          operations: ops.slice(0, 16).map((o) => ({ access: o.access, path: printable(o.path) })),
          preview: clip(preview, PREVIEW_CHARS), previewTruncated: preview.length > PREVIEW_CHARS,
        }, ac.signal)),
        timeout, cancelled,
      ]).catch((e: unknown) => {
        if (e instanceof BrokerError) throw e;
        throw denied("approval-error", "the approval could not be obtained");
      });
      if (isAborted(signal)) throw new BrokerError("E_CANCELLED", "aborted", "the call was cancelled");
      return verifyApproval(raw, digest, this.#now(), maxTtlMs, this.#ledger);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  #context(worktreeId: string, tool: ToolDefinition, signal: AbortSignal, stats: { bytesRead: number; bytesWritten: number; effects: number; endedBy: string | null; exitCode: number | null; outputBytes: number }, declared: readonly Declared[]): ToolContext {
    const d = this.#d;
    const contain = this.#contain;
    const guardFor = (access: "read" | "write"): TargetGuard => (t) => {
      // WT-3 at the time of use: the path must be one the call declared and the approval named, and it must still
      // resolve to the same real path. A directory swapped for a symlink since then lands somewhere else and is refused.
      const lex = this.#key(t.segments);
      const hit = declared.find((x) => x.lex === lex && (access === "read" || x.access === "write"));
      if (hit === undefined) throw denied("undeclared-path", "the tool touched a path it did not declare");
      if (hit.real !== this.#key(t.realSegments)) throw denied("path-changed", "the path no longer resolves to what was approved");
    };
    const alive = (): void => {
      if (signal.aborted) throw new BrokerError("E_CANCELLED", "aborted", "the call was cancelled");
    };
    return {
      worktreeId, signal,
      readFile: async (path, maxBytes) => {
        alive();
        const data = await readContained(contain, worktreeId, path, { maxBytes, guard: guardFor("read"), signal });
        stats.effects++;
        stats.bytesRead += data.length;
        return data;
      },
      writeFile: async (path, data, o) => {
        alive();
        const r = await writeContained(contain, worktreeId, path, data, { ...o, guard: guardFor("write"), signal });
        stats.effects++;
        stats.bytesWritten += r.bytes;
      },
      run: async (o) => {
        alive();
        const root = await resolveRoot(contain, worktreeId);
        const cwdTarget = await resolveTarget(contain, worktreeId, o.cwd ?? ".", "dir");
        const cwd = cwdTarget.segments.length === 0 ? root.root : [cwdTarget.parent, cwdTarget.name].join(this.#platform === "win32" ? "\\" : "/");
        const repos = d.registry.repositoryRoots();
        const built = buildToolEnv(d.parentEnv(), { tool: tool.name, worktreeId, ...(tool.envAdditions === undefined ? {} : { additions: tool.envAdditions }), ...(tool.envFixed === undefined ? {} : { fixed: tool.envFixed }) }, {
          platform: this.#platform, now: this.#now(), grants: d.grants?.grantsFor(tool.name, worktreeId) ?? [], excludeDirs: [root.root, ...repos],
        });
        const exe = await this.#executable(o.command, built.env, [root.root, ...repos]);
        const rec = await d.runner.run({
          argv: [exe, ...(o.args ?? [])], cwd, env: built.env, timeoutMs: o.timeoutMs, maxOutputBytes: o.maxOutputBytes,
          ...(o.stdin === undefined ? {} : { stdin: o.stdin }), signal,
        });
        stats.effects++;
        stats.endedBy = rec.endedBy;
        stats.exitCode = rec.exitCode;
        stats.outputBytes += rec.stdout.length + rec.stderr.length;
        return rec;
      },
      git: async (call) => {
        alive();
        if (this.#git === undefined) throw new BrokerError("E_UNAVAILABLE", "git-unavailable", "git is not configured");
        const { worktree, root } = await resolveRoot(contain, worktreeId);
        const result = await this.#git.run({ workTree: root, gitDir: worktree.gitDir }, call);
        stats.effects++;
        stats.exitCode = result.code;
        stats.outputBytes += result.stdout.length + result.stderr.length;
        return result;
      },
    };
  }

  #key(segs: readonly string[]): string {
    return segs.map((s) => foldName(s, this.#platform)).join("\0");
  }

  async #executable(command: string, env: Readonly<Record<string, string>>, exclude: readonly string[]): Promise<string> {
    if (typeof command !== "string") throw invalid("invalid-command", "the command is not valid");
    if (/^[A-Za-z]:[\\/]|^\//.test(command)) {
      // An absolute path is judged by its real path: never a program that lives in the worktree or a repository.
      const realExe = await this.#d.fs.realpath(command).catch(() => {
        throw new BrokerError("E_NOT_FOUND", "unresolved-command", "the command was not found");
      });
      if (exclude.some((x) => isUnder(realExe, x, this.#platform) || isUnder(command, x, this.#platform))) {
        throw denied("unresolved-command", "the command is inside the worktree");
      }
      return realExe;
    }
    const found = resolveExecutable(command, env, this.#platform, nodeFs, { excludeDirs: exclude });
    if (found === undefined) throw new BrokerError("E_NOT_FOUND", "unresolved-command", "the command was not found on PATH");
    return found;
  }
}
