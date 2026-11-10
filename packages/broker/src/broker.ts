// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { z } from "zod";
import { Redactor, canonicalize, type AuditActor, type AuditSink } from "@axis/audit";
import type { GitRunResult, GitRunner } from "@axis/git-ops";
import { BrokerAudit, BROKER_ACTIONS } from "./audit.js";
import { foldName } from "./lexical.js";
import { readContained, resolveRoot, resolveTarget, writeContained, type ContainDeps, type TargetGuard } from "./contain.js";
import { swapContained, type SwapResult } from "./swap.js";
import { buildToolEnv, type EnvGrantSource } from "./env.js";
import { BrokerError, denied, invalid, toBrokerError } from "./errors.js";
import type { BrokerFs } from "./fs.js";
import { checkGitCall, createBrokerGit, gitCallTier, gitKey, snapGit, GIT_COMMANDS, type BrokerGit, type GitCall } from "./git.js";
import { pinProgram, type PinnedProgram } from "./program.js";
import { callDigest, clip, clipText, escapeDisplay, printable } from "./text.js";
import { ApprovalLedger, ToolPolicy, verifyApproval, type ApprovalHook, type PolicyOptions, type VerifiedApproval } from "./policy.js";
import type { CommandRunner, RunRecord } from "./runner.js";
import { matchProtected } from "./protectedPaths.js";
import { maxTier, parseTier, tierRank, type Clock, type Env, type Tier, type ToolTarget, type WorktreeRegistry } from "./types.js";
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
  /** A compare-and-swap write (`swap.ts`): refused `E_CONFLICT` / `stale` unless the path holds `base`. The caller holds the write lock. */
  swapFile(path: string, data: Uint8Array, o: { readonly base: string; readonly maxBytes: number }): Promise<SwapResult>;
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
  /**
   * `argv[0]` of the command the call will start. `ctx.run` is refused unless the tool declared this (or `argv`) and starts
   * exactly that program, found and pinned when the policy decides. The arguments are then chosen at run time and the
   * approval says so: declare `argv` where they are known. A name on the launcher deny-list raises the call to `privileged`.
   */
  readonly command?: (args: A) => string | undefined;
  /** The whole command line, when it is known up front: `ctx.run` must then start exactly it, and the approval shows it. */
  readonly argv?: (args: A) => readonly string[] | undefined;
  /** The git calls this tool will make. `ctx.git` is refused unless the call is one of these; their tier and paths feed the decision. */
  readonly git?: (args: A) => readonly GitCall[] | undefined;
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

const isAborted = (s: AbortSignal | undefined): boolean => s?.aborted === true;

/** What a call declared it touches, resolved when the policy decided. A use that resolves anywhere else is refused. */
interface Declared {
  readonly access: "read" | "write";
  readonly lex: string;
  readonly real: string;
}

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

  /**
   * A tool with an invalid name or tier is refused here, not at call time. The definition is copied and frozen first
   * (every field read once, getters evaluated once) and every check, and every later call, uses that copy.
   */
  register<A>(def: ToolDefinition<A>): void {
    let copy: ToolDefinition;
    try {
      copy = Object.freeze({ ...def }) as unknown as ToolDefinition;
    } catch {
      throw invalid("invalid-call", "the tool definition is not valid");
    }
    if (typeof copy.name !== "string" || !TOOL_NAME.test(copy.name) || this.#tools.has(copy.name)) throw invalid("invalid-call", "the tool name is not valid");
    if (parseTier(copy.tier) === undefined) throw denied("invalid-tier", "the tool tier is not valid");
    // A command can leave its process group (setsid), so the approval floor is the only gate for it (PTY-4 residual).
    if ((copy.command !== undefined || copy.argv !== undefined) && !this.#policy.needsApproval(copy.tier)) {
      throw denied("invalid-tier", "a tool that starts a command must sit at or above the approval floor");
    }
    // Frozen all the way down: the nested lists and records the broker reads later cannot change either.
    this.#tools.set(copy.name, Object.freeze({
      ...copy,
      ...(copy.envAdditions === undefined ? {} : { envAdditions: Object.freeze([...copy.envAdditions]) }),
      ...(copy.envFixed === undefined ? {} : { envFixed: Object.freeze({ ...copy.envFixed }) }),
    }) as ToolDefinition);
  }

  async invoke(call: ToolCall): Promise<unknown> {
    const started = performance.now();
    // Every field is read exactly once, here: a getter cannot show the validation one value and the audit another.
    let tool0: unknown, wt0: unknown, actor0: unknown, args0: unknown, signal0: unknown;
    let signalBad = false;
    try {
      if (call === null || typeof call !== "object") throw new Error("shape");
      ({ tool: tool0, worktreeId: wt0, actor: actor0, args: args0, signal: signal0 } = call);
    } catch {
      throw invalid("invalid-call", "the call is not valid");
    }
    if (typeof actor0 !== "string" || !ACTOR.test(actor0)) throw invalid("invalid-call", "the call is not valid");
    try {
      // A forged signal (the prototype's getter on a plain object) throws here instead of later, out of the closed set.
      if (signal0 !== undefined && (!(signal0 instanceof AbortSignal) || typeof signal0.aborted !== "boolean")) signalBad = true;
    } catch {
      signalBad = true;
    }
    const actor = actor0 as AuditActor;
    const signal = signalBad ? undefined : (signal0 as AbortSignal | undefined);
    const worktreeId = typeof wt0 === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(wt0) ? wt0 : "invalid";
    const target = `worktree:${worktreeId}`;
    const toolName = typeof tool0 === "string" ? printable(tool0) : "invalid";
    const refuse = (e: BrokerError, extra: Record<string, string | number | boolean | null> = {}): never => {
      this.#audit.record({ actor, action: BROKER_ACTIONS.decision, target, outcome: "denied", payload: { tool: toolName, decision: "deny", reason: e.reason, ...extra } });
      throw e;
    };
    if (worktreeId === "invalid" || signalBad) return refuse(invalid("invalid-call", "the call is not valid"));
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
      const rawTargets = tool.targets?.(args) ?? [];
      if (!Array.isArray(rawTargets)) throw invalid("invalid-args", "the paths are not valid");
      // A copy, then the cap: a Set or a proxy cannot show the cap one length and the loop another.
      // Each target is read once: its access and path cannot differ between the policy and the declaration.
      const targets = [...rawTargets].map((t: ToolTarget) => ({ access: t.access, path: t.path }));
      if (targets.length > MAX_TARGETS) throw invalid("invalid-args", "too many paths");
      for (const { access: a0, path } of targets) {
        const access = a0 === "read" ? "read" : "write";
        const r = await resolveTarget(this.#contain, worktreeId, path, access === "read" ? "read" : "upsert");
        rels.push(r.rel);
        ops.push({ access, path: r.rel });
        declared.push({ access, lex: this.#key(r.segments), real: this.#key(r.realSegments) });
        if (r.protected !== undefined && (access === "write" || r.protected.gitDir)) {
          protectedHit = true;
          labels.push(r.protected.label);
        }
      }
    } catch (e) {
      return refuse(toBrokerError(e), { tier: tool.tier });
    }

    let argv0: string | undefined;
    let declaredArgv: readonly string[] | undefined;
    let pinned: PinnedProgram | undefined;
    let raised: Tier | undefined;
    const gitKeys = new Set<string>();
    const commands: string[] = [];
    try {
      const rawArgv = tool.argv?.(args);
      if (rawArgv !== undefined) {
        // A copy: the tool keeps no handle on what was judged and approved.
        declaredArgv = Array.isArray(rawArgv) ? Object.freeze([...rawArgv]) : undefined;
        if (declaredArgv === undefined || declaredArgv.some((x) => typeof x !== "string") || declaredArgv.length === 0 || declaredArgv.length > 256) {
          throw invalid("invalid-args", "the command line is not valid");
        }
      }
      argv0 = declaredArgv?.[0] ?? tool.command?.(args);
      if (argv0 !== undefined) {
        // The program is found and pinned now: the approval names the file, and the run must start that file.
        const { root } = await resolveRoot(this.#contain, worktreeId);
        // No vault grants yet: they are fetched when the command runs, after the user approved, and only PATH matters here.
        const env = this.#toolEnv(tool, worktreeId, root, this.#d.registry.repositoryRoots(), false);
        pinned = await pinProgram({ fs: this.#d.fs, platform: this.#platform }, argv0, env, [root, ...this.#d.registry.repositoryRoots()]);
        // The argument list is a JSON array: `["echo","a b","c"]` and `["echo","a","b c"]` are different lines.
        const via = pinned.interpreter === undefined ? "" : `; interpreter: ${JSON.stringify(pinned.interpreter.real)}`;
        commands.push(declaredArgv === undefined
          ? `${JSON.stringify([argv0])} [arguments are chosen when it runs; program: ${JSON.stringify(pinned.real)}${via}]`
          : `${JSON.stringify(declaredArgv)} [program: ${JSON.stringify(pinned.real)}${via}]`);
      }
      raised = tool.raise?.(args);
      const rawCalls = tool.git?.(args);
      if (rawCalls !== undefined && !Array.isArray(rawCalls)) throw invalid("invalid-args", "the git calls are not valid");
      // One frozen copy of each call: the tier, the paths, the key and the line below all describe the same values.
      const calls = [...(rawCalls ?? [])].map(snapGit);
      if (calls.length > 8) throw invalid("invalid-args", "too many git calls");
      if (calls.length > 0) {
        const { root } = await resolveRoot(this.#contain, worktreeId);
        for (const g of calls) {
          const checked = checkGitCall(g, root, this.#platform);
          const gt = gitCallTier(g);
          raised = raised === undefined ? gt : maxTier(raised, gt);
          const writes = GIT_COMMANDS[g.command].writes;
          // `restore` rewrites working files, and a directory path can hold protected ones anywhere: always ask.
          if (gt === "destructive" || tierRank(gt) > tierRank("write")) {
            protectedHit = true;
            labels.push("git-worktree");
          }
          for (const p of checked.paths) {
            const segs = p.split("/").filter((x) => x !== "." && x !== "");
            // `git add .` stages every changed file, protected ones included. A named directory is only checked lexically
            // (staging is not a write to the tree, and the commit is reviewed), but the whole tree always asks.
            if (writes && segs.length === 0) {
              protectedHit = true;
              labels.push("git-worktree");
            }
            const hit = matchProtected(segs, this.#d.extraProtected, this.#platform);
            if (hit !== undefined && (writes || hit.gitDir)) {
              protectedHit = true;
              labels.push(hit.label);
            }
            ops.push({ access: writes ? "write" : "read", path: p });
          }
          gitKeys.add(gitKey(g));
          commands.push(JSON.stringify(["git", g.command, ...(g.flags ?? []), ...(g.revs ?? []), ...(g.paths === undefined || g.paths.length === 0 ? [] : ["--", ...g.paths])]));
        }
      }
    } catch (e) {
      return refuse(toBrokerError(e), { tier: tool.tier });
    }
    const decision = this.#policy.decide({
      tool: tool.name, tier: tool.tier, protectedHit, protectedLabels: [...new Set(labels)],
      ...(argv0 === undefined ? {} : { argv0 }), ...(pinned === undefined ? {} : { program: pinned.real }), ...(pinned?.interpreter === undefined ? {} : { interpreter: pinned.interpreter.real }), ...(pinned?.opaque === true ? { opaque: true } : {}),
      ...(argv0 !== undefined && declaredArgv === undefined ? { argsAtRunTime: true } : {}),
      ...(raised === undefined ? {} : { raisedTier: raised }),
    });
    if (decision.effect === "deny") return refuse(denied("invalid-tier", "the tool tier is not valid"));

    let digest: string;
    try {
      digest = callDigest({ tool: tool.name, worktreeId, actor, tier: decision.tier, paths: ops.map((o) => `${o.access}:${o.path}`), commands, args });
    } catch {
      return refuse(invalid("invalid-args", "the arguments cannot be approved"), { tier: decision.tier });
    }

    let approval: VerifiedApproval | undefined;
    if (decision.effect === "approve") {
      try {
        const preview = escapeDisplay(this.#redactor.redactString(canonicalize(args as never)));
        approval = await this.#approve(signal, tool.name, decision.tier, decision.reasons, ops, preview, commands.map((c) => this.#redactor.redactString(c)), digest, worktreeId, actor);
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
      result = await tool.run(this.#context(worktreeId, tool, ac.signal, stats, declared, { tier: decision.tier, argv0, argv: declaredArgv, gitKeys, pinned }), args);
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

  async #approve(signal: AbortSignal | undefined, tool: string, tier: Tier, reasons: readonly string[], ops: readonly { access: "read" | "write"; path: string }[], preview: string, commands: readonly string[], digest: string, worktreeId: string, actor: string): Promise<VerifiedApproval> {
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
    const shownCommands = commands.map((c) => clipText(escapeDisplay(c), 1024));
    let timer: NodeJS.Timeout | undefined;
    let onCancel: (() => void) | undefined;
    try {
      if (signal?.aborted === true) throw new BrokerError("E_CANCELLED", "aborted", "the call was cancelled");
      // A hook that ignores its signal and answers "yes" after the call was cancelled must not start the action.
      const cancelled = new Promise<never>((_, reject) => {
        onCancel = (): void => reject(new BrokerError("E_CANCELLED", "aborted", "the call was cancelled"));
        signal?.addEventListener("abort", onCancel, { once: true });
      });
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          ac.abort();
          reject(new BrokerError("E_TIMEOUT", "approval-timeout", "the approval timed out"));
        }, timeoutMs) as unknown as NodeJS.Timeout; // opaque handle under Code OSS's typings (ADR 0005)
      });
      const raw = await Promise.race([
        Promise.resolve().then(() => hook.request({
          digest, tool, tier, worktreeId, actor, reasons: [...reasons], targets: ops.map((o) => printable(o.path)), maxTtlMs,
          // Every operation and every command line is listed (declared targets and git calls are capped), so nothing is cut from what is shown.
          operations: ops.map((o) => ({ access: o.access, path: printable(o.path) })),
          commands: shownCommands, commandsTruncated: shownCommands.some((c, i) => c.length < escapeDisplay(commands[i] as string).length),
          preview: clipText(preview, PREVIEW_CHARS), previewTruncated: preview.length > PREVIEW_CHARS,
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
      if (onCancel !== undefined) signal?.removeEventListener("abort", onCancel);
    }
  }

  #context(worktreeId: string, tool: ToolDefinition, signal: AbortSignal, stats: { bytesRead: number; bytesWritten: number; effects: number; endedBy: string | null; exitCode: number | null; outputBytes: number }, declared: readonly Declared[], cmd: { readonly tier: Tier; readonly argv0: string | undefined; readonly argv: readonly string[] | undefined; readonly gitKeys: ReadonlySet<string>; readonly pinned: PinnedProgram | undefined }): ToolContext {
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
      swapFile: async (path, data, o) => {
        alive();
        const r = await swapContained(contain, worktreeId, path, data, { base: o.base, maxBytes: o.maxBytes, guard: guardFor("write"), signal });
        stats.effects++;
        stats.bytesWritten += r.bytes;
        return r;
      },
      run: async (o) => {
        alive();
        // One read of every field: what is checked below is what is started, whatever the tool does to `o` afterwards.
        const { command, args: rawArgs, cwd: cwd0, timeoutMs, maxOutputBytes, stdin } = o;
        const args = rawArgs === undefined ? [] : Array.isArray(rawArgs) ? [...rawArgs] : undefined;
        // PTY-4 at the time of use: only the program (and, when declared, the exact arguments) the policy judged and the user approved.
        if (cmd.argv0 === undefined || cmd.pinned === undefined || command !== cmd.argv0 || args === undefined || args.some((x) => typeof x !== "string")) {
          throw denied("undeclared-command", "the tool started a command it did not declare");
        }
        if (cmd.argv !== undefined) {
          const want = cmd.argv.slice(1);
          if (args.length !== want.length || args.some((x, i) => x !== want[i])) throw denied("undeclared-command", "the command line is not the one that was approved");
        }
        const root = await resolveRoot(contain, worktreeId);
        const cwdTarget = await resolveTarget(contain, worktreeId, cwd0 ?? ".", "dir");
        const cwd = cwdTarget.segments.length === 0 ? root.root : [cwdTarget.parent, cwdTarget.name].join(this.#platform === "win32" ? "\\" : "/");
        const repos = d.registry.repositoryRoots();
        const env = this.#toolEnv(tool, worktreeId, root.root, repos);
        const pin = await pinProgram({ fs: d.fs, platform: this.#platform }, command, env, [root.root, ...repos]);
        // The file that runs is the file that was approved. A same-user process that swaps it after this check can still win the race (design §5).
        // The same file, not the same name: a rename over it, a copy or an edit in place changes its identity.
        if (JSON.stringify(pin) !== JSON.stringify(cmd.pinned)) throw denied("program-changed", "the program is not the one that was approved");
        const rec = await d.runner.run({
          argv: [pin.exe, ...args], cwd, env, timeoutMs, maxOutputBytes,
          ...(stdin === undefined ? {} : { stdin }), signal,
        });
        stats.effects++;
        stats.endedBy = rec.endedBy;
        stats.exitCode = rec.exitCode;
        stats.outputBytes += rec.stdout.length + rec.stderr.length;
        return rec;
      },
      git: async (call) => {
        alive();
        // One frozen copy: the key checked here is the call that runs.
        let snap: GitCall;
        try {
          snap = snapGit(call);
          if (!cmd.gitKeys.has(gitKey(snap))) throw new Error("undeclared");
        } catch {
          throw denied("undeclared-git", "the tool made a git call it did not declare");
        }
        if (this.#git === undefined) throw new BrokerError("E_UNAVAILABLE", "git-unavailable", "git is not configured");
        const { worktree, root } = await resolveRoot(contain, worktreeId);
        const result = await this.#git.run({ workTree: root, gitDir: worktree.gitDir }, snap, signal);
        stats.effects++;
        stats.exitCode = result.code;
        stats.outputBytes += result.stdout.length + result.stderr.length;
        return result;
      },
    };
  }

  /** The environment a tool's command gets, and the one its program is looked up on. */
  #toolEnv(tool: ToolDefinition, worktreeId: string, root: string, repos: readonly string[], grants = true): Readonly<Record<string, string>> {
    const d = this.#d;
    return buildToolEnv(d.parentEnv(), { tool: tool.name, worktreeId, ...(tool.envAdditions === undefined ? {} : { additions: tool.envAdditions }), ...(tool.envFixed === undefined ? {} : { fixed: tool.envFixed }) }, {
      platform: this.#platform, now: this.#now(), grants: grants ? (d.grants?.grantsFor(tool.name, worktreeId) ?? []) : [], excludeDirs: [root, ...repos],
    }).env;
  }

  #key(segs: readonly string[]): string {
    return segs.map((s) => foldName(s, this.#platform)).join("\0");
  }
}
