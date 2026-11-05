// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// WT-2 (broker side) and GIT-ENV-1: git run for a composer tool call. Reuses the @axis/git-ops hardened prefix.
import { daemonGitEnv, filterNames, guardedRunner, prefix, requireGitVersion, safeRef, type GitOpsDeps, type GitRunResult, type GitRunner, type WorktreeRef } from "@axis/git-ops";
import { BrokerError, denied, invalid } from "./errors.js";
import { lexicalSegments, relText } from "./lexical.js";
import type { Env, Tier } from "./types.js";

export type GitCommand = "status" | "diff" | "log" | "show" | "ls-files" | "add" | "restore";

interface Spec {
  readonly tier: Tier;
  /** Exact flags the model may pass. */
  readonly flags: ReadonlySet<string>;
  /** Flags with a numeric value, such as `--max-count=20`. */
  readonly numeric: readonly string[];
  /** Always added, before the model's flags. */
  readonly fixed: readonly string[];
  readonly revs: "none" | "optional" | "required";
  readonly paths: "none" | "optional" | "required";
  readonly writes: boolean;
}

const set = (...f: string[]): ReadonlySet<string> => new Set(f);
// Patch-producing commands never run external diff or textconv drivers or signature programs, whatever the config says.
const DIFFING = ["--no-ext-diff", "--no-textconv", "--no-color"] as const;

export const GIT_COMMANDS: Readonly<Record<GitCommand, Spec>> = {
  status: { tier: "read", flags: set("--short", "-s", "--branch", "-b", "--porcelain", "--porcelain=v1", "--porcelain=v2", "-z", "--no-renames", "-uno", "-unormal", "-uall", "--untracked-files=no", "--untracked-files=normal", "--untracked-files=all"), numeric: [], fixed: ["--no-ahead-behind"], revs: "none", paths: "optional", writes: false },
  diff: { tier: "read", flags: set("--stat", "--numstat", "--shortstat", "--name-only", "--name-status", "--cached", "--staged", "--patch", "-p", "--no-renames", "-z", "--exit-code", "--quiet", "--check", "--raw", "--summary", "--ignore-all-space", "-w"), numeric: ["--unified"], fixed: DIFFING, revs: "optional", paths: "optional", writes: false },
  log: { tier: "read", flags: set("--oneline", "--stat", "--name-only", "--name-status", "--no-merges", "--first-parent", "--no-decorate", "--reverse"), numeric: ["--max-count", "--skip"], fixed: [...DIFFING, "--no-show-signature"], revs: "optional", paths: "optional", writes: false },
  show: { tier: "read", flags: set("--stat", "--name-only", "--name-status", "--no-patch", "-s", "--oneline", "--patch", "-p"), numeric: ["--unified"], fixed: [...DIFFING, "--no-show-signature"], revs: "required", paths: "optional", writes: false },
  "ls-files": { tier: "read", flags: set("-z", "--cached", "-c", "--others", "-o", "--modified", "-m", "--deleted", "-d", "--exclude-standard", "--stage", "-s", "--full-name"), numeric: [], fixed: [], revs: "none", paths: "optional", writes: false },
  add: { tier: "write", flags: set("--update", "-u", "--intent-to-add", "-N", "--dry-run", "-n", "--verbose", "-v"), numeric: [], fixed: [], revs: "none", paths: "required", writes: true },
  restore: { tier: "write", flags: set("--staged", "-S", "--worktree", "-W"), numeric: [], fixed: [], revs: "none", paths: "required", writes: true },
};

export interface GitCall {
  readonly command: GitCommand;
  readonly flags?: readonly string[];
  /** Revisions or ranges (`A..B`). Placed after `--end-of-options`. */
  readonly revs?: readonly string[];
  /** Paths below the worktree root. Placed after `--`, and literal (no pathspec magic). */
  readonly paths?: readonly string[];
}

const HEX = /^[0-9a-f]{4,64}$/;
const HEAD = /^HEAD(?:[~^]\d{0,4})*$/;
const MAX_ITEMS = 64;

function revPart(r: string): boolean {
  if (HEX.test(r) || HEAD.test(r)) return true;
  try {
    safeRef(r, "revision");
    return true;
  } catch {
    return false;
  }
}
function validRev(r: unknown): r is string {
  if (typeof r !== "string" || r.length === 0 || r.length > 256 || r.startsWith("-") || r.includes("\0")) return false;
  const m = /^(.+?)(\.\.\.?)(.+)$/.exec(r);
  return m === null ? revPart(r) : revPart(m[1] as string) && revPart(m[3] as string);
}

/**
 * One deep, frozen copy of a call: every field is read exactly once and the arrays are copied, so a getter or a later
 * mutation by the tool cannot show the check one call and the runner another. Validation happens on the copy.
 */
export function snapGit(call: unknown): GitCall {
  if (call === null || typeof call !== "object") throw denied("git-command", "the git command is not allowed");
  const { command, flags, revs, paths } = call as { command?: unknown; flags?: unknown; revs?: unknown; paths?: unknown };
  const copy = (v: unknown): readonly string[] | undefined => (Array.isArray(v) ? Object.freeze([...(v as string[])]) : (v as undefined));
  return Object.freeze({ command: command as GitCommand, flags: copy(flags), revs: copy(revs), paths: copy(paths) }) as GitCall;
}

/** What identifies a call: the declaration and the call at the time of use are compared by this. */
export const gitKey = (g: GitCall): string => JSON.stringify([g.command, g.flags ?? [], g.revs ?? [], g.paths ?? []]);

/** The tier of a call. `restore` of the working tree discards uncommitted work, so it is destructive. */
export function gitCallTier(call: GitCall): Tier {
  if (call === null || typeof call !== "object" || typeof call.command !== "string" || !Object.hasOwn(GIT_COMMANDS, call.command)) {
    throw denied("git-command", "the git command is not allowed");
  }
  const spec = GIT_COMMANDS[call.command];
  const f = call.flags ?? [];
  if (call.command === "restore" && (f.length === 0 || f.includes("--worktree") || f.includes("-W"))) return "destructive";
  return spec.tier;
}

/** Validates a call and returns its path arguments as worktree-relative POSIX text. Pure. */
export function checkGitCall(call: GitCall, root: string, platform: NodeJS.Platform): { readonly flags: string[]; readonly revs: string[]; readonly paths: string[] } {
  if (call === null || typeof call !== "object" || typeof call.command !== "string" || !Object.hasOwn(GIT_COMMANDS, call.command)) {
    throw denied("git-command", "the git command is not allowed");
  }
  const spec = GIT_COMMANDS[call.command];
  const flags = call.flags ?? [];
  const revs = call.revs ?? [];
  const paths = call.paths ?? [];
  if (![flags, revs, paths].every((a) => Array.isArray(a) && a.length <= MAX_ITEMS)) throw invalid("git-flag", "too many git arguments");
  for (const f of flags) {
    const ok = typeof f === "string" && (spec.flags.has(f) || spec.numeric.some((n) => new RegExp(`^${n}=\\d{1,6}$`).test(f)));
    if (!ok) throw denied("git-flag", "the git flag is not allowed");
  }
  if (spec.revs === "none" ? revs.length > 0 : spec.revs === "required" && revs.length === 0) throw invalid("git-rev", "the revision arguments are not valid");
  if (!revs.every(validRev)) throw invalid("git-rev", "a revision is not valid");
  if (spec.paths === "none" ? paths.length > 0 : spec.paths === "required" && paths.length === 0) throw invalid("git-path", "the path arguments are not valid");
  // lexicalSegments applies the WT-1 rules (no `..`, no backslash, absolute only under the root); the result is relative.
  const rel = paths.map((p) => relText(lexicalSegments(p, root, platform)));
  return { flags: [...flags], revs: [...revs], paths: rel };
}

export interface BrokerGitDeps {
  /** The production runner is `createNodeRunner()` from @axis/git-ops; tests may fake it. */
  readonly runner: GitRunner;
  /** The parent environment; only the GIT-ENV-1 allow-list is used. */
  readonly parentEnv: Env;
  /** GIT-SNAP-1 re-take: throws when the common dir drifted from the acknowledged baseline. */
  readonly assertNoDrift: (w: WorktreeRef) => Promise<void>;
  readonly platform?: NodeJS.Platform;
  readonly emptyHooksDir?: string;
}

export interface BrokerGit {
  run(w: WorktreeRef, call: GitCall, signal?: AbortSignal): Promise<GitRunResult>;
}

export function createBrokerGit(d: BrokerGitDeps): BrokerGit {
  const platform = d.platform ?? process.platform;
  const gitOps: GitOpsDeps = {
    runner: d.runner,
    env: { daemon: d.parentEnv, pty: {} },
    runHooks: false,
    isCliRunActive: () => false,
    assertNoDrift: d.assertNoDrift,
    platform,
    ...(d.emptyHooksDir === undefined ? {} : { emptyHooksDir: d.emptyHooksDir }),
  };
  const drift = async (w: WorktreeRef, executed: boolean): Promise<void> => {
    try {
      await d.assertNoDrift(w);
    } catch {
      throw new BrokerError("E_CONFLICT", "git-drift", "the repository changed outside the tool call", { executed });
    }
  };
  return {
    async run(w, call, signal) {
      // The runner takes no signal, so cancellation is checked between every step and before git itself starts.
      const alive = (): void => {
        if (signal?.aborted === true) throw new BrokerError("E_CANCELLED", "aborted", "the call was cancelled");
      };
      alive();
      const { flags, revs, paths } = checkGitCall(call, w.workTree, platform);
      const spec = GIT_COMMANDS[call.command];
      await drift(w, false);
      alive();
      try {
        const env = daemonGitEnv(d.parentEnv, platform);
        // `--end-of-options` needs git 2.24: say so plainly instead of failing on an unknown flag.
        await requireGitVersion(gitOps, w, env);
        alive();
        const filters = await filterNames(w, gitOps, env);
        alive();
        const argv = [
          ...prefix(w, gitOps, { context: "daemon", hooks: false, filters }),
          // Literal pathspecs: `*`, `:(top)` and friends are plain characters. No optional locks: reads never write the index.
          "--literal-pathspecs", "--no-optional-locks",
          call.command, ...spec.fixed, ...flags,
          ...(revs.length > 0 ? ["--end-of-options", ...revs] : []),
          ...(paths.length > 0 ? ["--", ...paths] : []),
        ];
        const result = await guardedRunner(d.runner, gitOps).run({ argv, cwd: w.workTree, env, context: "daemon" });
        if (spec.writes) await drift(w, true);
        return result;
      } catch (e) {
        if (e instanceof BrokerError) throw e;
        // Errors from git-ops carry a protocol code and fixed text. A refusal stays a refusal; anything else is an unavailable git.
        if ((e as { code?: unknown } | null)?.code === "E_POLICY_DENIED") throw denied("git-command", "the git call was refused");
        throw new BrokerError("E_UNAVAILABLE", "git-unavailable", "git could not be run");
      }
    },
  };
}
