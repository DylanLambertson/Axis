// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// WT-3, DMN-3, ANT-2: tier policy with an injected approval hook. Every unknown or malformed input denies.
import { z } from "zod";
import { BrokerError, denied } from "./errors.js";
import { maxTier, parseTier, tierRank, type Tier } from "./types.js";

/**
 * Programs known to run other programs or interpret a command string. A match raises the call to `privileged`. This is a
 * deny-list: it is a convenience that adds a reason and a tier, not a boundary. A wrapper or an editor that is not on it
 * runs at the tool's own tier, so the approval for a command shows the resolved program and, when the tool declared
 * `argv`, the whole command line (see `args-at-run-time`).
 */
const LAUNCHERS = new Set([
  "sh", "bash", "zsh", "dash", "ksh", "fish", "csh", "tcsh", "ash", "busybox", "env", "xargs", "sudo", "su", "doas", "nohup", "nice",
  "timeout", "time", "setsid", "script", "cmd", "powershell", "pwsh", "wsl", "start", "runas", "osascript", "open", "launchctl", "ssh",
  "rbash", "mksh", "yash", "stdbuf", "chroot", "unshare", "nsenter", "find", "make", "gmake", "npx", "pnpx", "xvfb-run", "flock", "strace", "ltrace",
  "setarch", "linux32", "linux64", "taskset", "ionice", "chrt", "prlimit", "setpriv", "runuser", "watch", "run-parts", "systemd-run", "dbus-run-session",
  "tar", "bsdtar", "rsync", "vim", "vi", "nvim", "view", "ex", "ed", "emacs", "less", "more", "man", "npm", "pnpm", "yarn", "cargo", "go", "uv", "pip", "pip3",
  "docker", "podman", "coreutils", "gdb", "lldb", "py", "forfiles", "msiexec", "regsvr32", "msbuild", "scp", "sftp",
  "git", "gh", "awk", "gawk", "mawk", "nawk", "sed", "perl", "php", "lua", "tclsh", "expect", "deno", "bun", "bunx", "osascript", "cscript", "wscript", "mshta", "rundll32",
]);
/** Interpreters carry a version in the name (`python3.12`, `ruby3.2`, `node22`). */
/** Multi-call binaries: `busybox`, `busybox-static`, `busybox.nosuid`. */
const MULTICALL = /^busybox[\w.-]*$/;
const INTERPRETER = /^(?:python|pypy|ruby|node|nodejs|perl|php|lua|java)[\d.]*$/;
/** The dynamic loader runs any program it is given: `ld.so`, `ld-linux-x86-64.so.2`, `ld-2.31.so`. */
const LOADER = /^ld(?:-[\w.-]+)?\.so(?:\.\d+)*$/;

export function isLauncher(argv0: string): boolean {
  const base = (argv0.split(/[\\/]/).pop() ?? "").toLowerCase().replace(/\.(exe|com|bat|cmd)$/, "");
  return LAUNCHERS.has(base) || INTERPRETER.test(base) || MULTICALL.test(base) || LOADER.test(base);
}

export interface PolicyInput {
  readonly tool: string;
  /** The tool's declared tier, as stored. Validated again here. */
  readonly tier: unknown;
  /** True if any target is a protected path (a write), or a Git directory path (any access). */
  readonly protectedHit: boolean;
  readonly protectedLabels: readonly string[];
  readonly argv0?: string;
  /** The real path of the program, when it was resolved: judged like `argv0`. */
  readonly program?: string;
  /** The `#!` interpreter of a script, judged the same way: `#!/bin/sh` runs a shell whatever the file is called. */
  readonly interpreter?: string;
  /** The program cannot be judged (an unreadable script, or a chain of scripts): it is treated as a launcher. */
  readonly opaque?: boolean;
  /** True when the tool declared only the program: its arguments are chosen when it runs, so the approval cannot show them. */
  readonly argsAtRunTime?: boolean;
  /** A tier the git table or another computed rule raised, validated here. */
  readonly raisedTier?: unknown;
}

export type Decision =
  | { readonly effect: "deny"; readonly reason: "invalid-tier" | "decision-hook"; readonly tier?: undefined; readonly reasons: readonly string[] }
  | { readonly effect: "allow" | "approve"; readonly tier: Tier; readonly reasons: readonly string[] };

/**
 * Asked for EVERY call, after the tier, the launcher list and the protected paths decided, before any approval (the
 * daemon's taint rule IAC-T, ticket PV-M0). It can only raise: `approve: true` makes the call need the user's approval
 * whatever the floor, the tier or any other rule allowed, and its reasons (closed labels) join the decision's. It never
 * lowers a decision. An answer of any other shape, a reason that is not a label, or a throw denies the call.
 */
export interface DecisionHook {
  decide(call: { readonly tool: string; readonly tier: Tier }): { readonly approve: boolean; readonly reasons: readonly string[] };
}

export interface PolicyOptions {
  /** Calls at this tier or above need approval. Default `network`. */
  readonly approvalFloor?: unknown;
  readonly hook?: DecisionHook;
}

const HOOK_REASON = /^[a-z][a-z0-9:._-]{0,63}$/;

export class ToolPolicy {
  readonly #floor: Tier;
  readonly #hook: DecisionHook | undefined;
  constructor(options: PolicyOptions = {}) {
    this.#hook = options.hook;
    const floor = options.approvalFloor === undefined ? "network" : parseTier(options.approvalFloor);
    // A floor that is not a tier would make every comparison false and skip the gate, so it is refused at construction.
    if (floor === undefined) throw denied("invalid-tier", "the approval floor is not a tier");
    this.#floor = floor;
  }

  /** Whether a call at `tier` needs approval on tier alone (protected paths add to this). */
  needsApproval(tier: unknown): boolean {
    const t = parseTier(tier);
    return t !== undefined && tierRank(t) >= tierRank(this.#floor);
  }

  decide(input: PolicyInput): Decision {
    let tier = parseTier(input.tier);
    if (tier === undefined) return { effect: "deny", reason: "invalid-tier", reasons: ["the tool tier is not valid"] };
    if (input.raisedTier !== undefined) {
      const raised = parseTier(input.raisedTier);
      if (raised === undefined) return { effect: "deny", reason: "invalid-tier", reasons: ["a computed tier is not valid"] };
      tier = maxTier(tier, raised);
    }
    const reasons: string[] = [];
    if ((input.argv0 !== undefined && isLauncher(input.argv0)) || (input.program !== undefined && isLauncher(input.program)) || (input.interpreter !== undefined && isLauncher(input.interpreter))) {
      tier = maxTier(tier, "privileged");
      reasons.push("launcher");
    }
    if (input.opaque === true) {
      tier = maxTier(tier, "privileged");
      reasons.push("opaque-program");
    }
    if (input.argsAtRunTime === true) reasons.push("args-at-run-time");
    let approve = tierRank(tier) >= tierRank(this.#floor);
    if (approve) reasons.push(`tier:${tier}`);
    if (input.protectedHit) {
      // Whatever the floor: protected paths always need an explicit approval.
      approve = true;
      reasons.push(...input.protectedLabels.map((l) => `protected:${l}`));
    }
    if (this.#hook !== undefined) {
      let raise: boolean;
      try {
        const out: unknown = this.#hook.decide({ tool: input.tool, tier });
        const r = out as { approve?: unknown; reasons?: unknown } | null;
        const labels = typeof r === "object" && r !== null && Array.isArray(r.reasons) ? [...(r.reasons as unknown[])] : undefined;
        if (typeof r?.approve !== "boolean" || labels === undefined || labels.length > 8 || !labels.every((l) => typeof l === "string" && HOOK_REASON.test(l))) throw new Error("shape");
        raise = r.approve;
        if (raise) reasons.push(...(labels as string[]));
      } catch {
        return { effect: "deny", reason: "decision-hook", reasons: ["the call could not be judged"] };
      }
      // Only ever raises: an untainted answer leaves the tier policy's decision as it was.
      if (raise) approve = true;
    }
    return { effect: approve ? "approve" : "allow", tier, reasons };
  }
}

/** What the approval hook is asked. Text fields are display-safe and bounded. */
export interface ApprovalRequest {
  readonly digest: string;
  readonly tool: string;
  readonly tier: Tier;
  readonly worktreeId: string;
  readonly actor: string;
  readonly reasons: readonly string[];
  readonly targets: readonly string[];
  /**
   * The command lines the call may run (the declared program with its resolved path, and each git call), redacted, bidi
   * controls escaped. When the tool declared only a program, the line says its arguments are chosen at run time.
   */
  readonly commands: readonly string[];
  /** True if a command line was cut to its display limit. */
  readonly commandsTruncated: boolean;
  /** The real, worktree-relative paths and what the call does to each, so the UI can name what it approves. */
  readonly operations: readonly { readonly access: "read" | "write"; readonly path: string }[];
  /** The canonical arguments (content included), redacted, bidi controls escaped, bounded. The UI should still treat it as untrusted text. The digest is over the full arguments. */
  readonly preview: string;
  readonly previewTruncated: boolean;
  readonly maxTtlMs: number;
}

/** The only shape accepted as "approved". `approvedBy` is the user: an agent cannot approve its own call (DMN-3). */
export const approvalGrantSchema = z.strictObject({
  approved: z.literal(true),
  approvedBy: z.literal("user"),
  approvalId: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  expiresAt: z.number().int().positive(),
});
export const approvalDeclineSchema = z.strictObject({ approved: z.literal(false), reason: z.string().max(256).optional() });

export interface ApprovalHook {
  request(req: ApprovalRequest, signal: AbortSignal): Promise<unknown>;
}

export interface VerifiedApproval {
  readonly approvalId: string;
  readonly approvedBy: "user";
  readonly expiresAt: number;
}

/** Remembers approval ids until they expire, so a hook that returns the same id twice is refused. Bounded. */
export class ApprovalLedger {
  readonly #seen = new Map<string, number>();
  constructor(readonly max = 4096) {}
  spend(id: string, expiresAt: number, now: number): void {
    for (const [k, exp] of this.#seen) if (exp <= now) this.#seen.delete(k);
    if (this.#seen.has(id)) throw denied("approval-replayed", "the approval was already used");
    if (this.#seen.size >= this.max) throw new BrokerError("E_BACKPRESSURE", "approval-limit", "too many approvals are outstanding");
    this.#seen.set(id, expiresAt);
  }
}

/** Validates a hook's answer against the request. Anything unexpected denies. */
export function verifyApproval(raw: unknown, digest: string, now: number, maxTtlMs: number, ledger: ApprovalLedger): VerifiedApproval {
  const decline = approvalDeclineSchema.safeParse(raw);
  if (decline.success) throw denied("approval-declined", "the user declined the call");
  const ok = approvalGrantSchema.safeParse(raw);
  if (!ok.success) {
    // An approver other than the user is its own refusal; the zod text is never echoed.
    const by = typeof raw === "object" && raw !== null ? (raw as { approvedBy?: unknown }).approvedBy : undefined;
    throw denied(by !== undefined && by !== "user" ? "bad-approver" : "approval-malformed", "the approval is not valid");
  }
  const g = ok.data;
  if (g.digest !== digest) throw denied("approval-mismatch", "the approval is for a different call");
  if (g.expiresAt <= now) throw denied("approval-expired", "the approval has expired");
  if (g.expiresAt > now + maxTtlMs) throw denied("approval-malformed", "the approval lasts too long");
  ledger.spend(g.approvalId, g.expiresAt, now);
  return { approvalId: g.approvalId, approvedBy: "user", expiresAt: g.expiresAt };
}
