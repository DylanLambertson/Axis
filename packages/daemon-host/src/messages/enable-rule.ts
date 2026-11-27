// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { CLI_PROJECT_CONFIG, type CliProjectConfig } from "@axis/pty-policy";

/**
 * Whether CLI messaging may be enabled for a worker (PV-M7 slice 1; endpoint design section 6, M-3; ADR 0007 §6): a pure
 * decision over the worker's launch argv, the user's marking and which CLI project-configuration files exist. Checked when
 * the user enables it and again at every mint, on the argv that actually runs.
 *
 * Order: the user's marking (the primary signal: a flag list is incomplete by nature), then the flag table, then the
 * fail-closed pattern rule, then the repository configuration (a warning, or a refusal when its row's severity says so).
 * A decision names the rule that fired, never an argument.
 */

/** One known bypass flag, verified in the CLI's own help (no network). `value` set: only that value of the flag. */
interface FlagRow {
  readonly id: string;
  readonly cli: "claude" | "codex";
  readonly flags: readonly string[];
  readonly value?: string;
  readonly source: string;
}
const CLAUDE_HELP = "Claude Code 2.1.330 --help";
const CODEX_HELP = "codex-cli 0.166.0 --help";
const row = (id: string, cli: FlagRow["cli"], flags: readonly string[], source: string, value?: string): FlagRow =>
  Object.freeze({ id, cli, flags: Object.freeze([...flags]), source, ...(value === undefined ? {} : { value }) });

/** Every row refuses (master decision a, 2026-11-22): a row becomes a warning only by a reviewed change to this table. */
export const BYPASS_FLAGS: readonly FlagRow[] = Object.freeze([
  row("claude.dangerously-skip-permissions", "claude", ["--dangerously-skip-permissions"], CLAUDE_HELP),
  row("claude.allow-dangerously-skip-permissions", "claude", ["--allow-dangerously-skip-permissions"], CLAUDE_HELP),
  row("claude.permission-mode.bypassPermissions", "claude", ["--permission-mode"], CLAUDE_HELP, "bypasspermissions"),
  row("claude.permission-mode.auto", "claude", ["--permission-mode"], CLAUDE_HELP, "auto"),
  row("claude.permission-mode.acceptEdits", "claude", ["--permission-mode"], CLAUDE_HELP, "acceptedits"),
  row("codex.dangerously-bypass-approvals-and-sandbox", "codex", ["--dangerously-bypass-approvals-and-sandbox"], CODEX_HELP),
  row("codex.ask-for-approval.never", "codex", ["--ask-for-approval", "-a"], CODEX_HELP, "never"),
  row("codex.sandbox.danger-full-access", "codex", ["--sandbox", "-s"], CODEX_HELP, "danger-full-access"),
  row("codex.approve-for-me", "codex", ["--approve-for-me"], CODEX_HELP),
  row("codex.config.approval_policy.never", "codex", ["--config", "-c"], CODEX_HELP, "approval_policy=never"),
  row("codex.config.sandbox_mode.danger-full-access", "codex", ["--config", "-c"], CODEX_HELP, "sandbox_mode=danger-full-access"),
]);

/** Words that mark a bypass in any CLI's argument (decision 2: fail closed for what the table does not know), folded. */
export const BYPASS_WORDS: readonly string[] = Object.freeze([
  "dangerously", "yolo", "bypass", "skip-permissions", "no-confirm", "auto-approve", "full-auto", "approval-mode", "danger-full-access", "no-sandbox", "sandbox=false",
]);

export type EnableWarning = { readonly code: "repo_config"; readonly path: string; readonly cli: string };
export type EnableDecision = { readonly allowed: false; readonly rule: string } | { readonly allowed: true; readonly warnings: readonly EnableWarning[] };

/** The facts the rule decides over. `argv` is the whole launch argv, `argv[0]` the executable. */
export interface EnableFacts {
  readonly argv: readonly string[];
  readonly bypassesPrompts: boolean;
  /** Whether the root-relative path (folded segments) exists in the worker's workspace. */
  readonly exists: (segments: readonly string[]) => boolean;
}

/** Folded for comparison: lower case, `_` read as `-` in words, quotes and spaces of a TOML value dropped. */
const fold = (s: string): string => s.toLowerCase().replace(/["'\s]/g, "");
/** Which CLI an executable is: its base name without a Windows extension; anything else is unknown (the pattern rule still applies). */
export function cliOf(executable: string): string {
  const base = executable.split(/[\\/]/).pop() ?? "";
  return base.toLowerCase().replace(/\.(exe|cmd|bat|ps1|js|mjs)$/, "");
}

/** The table row an argv matches, if any: `--flag value`, `--flag=value`, or the bare flag for a row without a value. */
function tableHit(cli: string, args: readonly string[]): FlagRow | undefined {
  for (let i = 0; i < args.length; i++) {
    const tok = args[i] as string;
    const eq = tok.indexOf("=");
    const name = eq > 0 && tok.startsWith("-") ? tok.slice(0, eq) : tok;
    const inline = eq > 0 && tok.startsWith("-") ? tok.slice(eq + 1) : undefined;
    for (const r of BYPASS_FLAGS) {
      if (r.cli !== cli || !r.flags.includes(name)) continue;
      if (r.value === undefined) return r;
      const v = inline ?? args[i + 1];
      if (v !== undefined && fold(v) === fold(r.value)) return r;
    }
  }
  return undefined;
}

/** `config`: the repository-configuration rows (the shared list; a test passes its own to reach a `refuse` row). */
export function decideCliMessaging(facts: EnableFacts, config: readonly CliProjectConfig[] = CLI_PROJECT_CONFIG): EnableDecision {
  if (facts.bypassesPrompts) return { allowed: false, rule: "user_marked" };
  const [executable = "", ...args] = facts.argv;
  const cli = cliOf(executable);
  const hit = tableHit(cli, args);
  if (hit !== undefined) return { allowed: false, rule: hit.id };
  for (const a of args) {
    const f = fold(a).replace(/_/g, "-");
    if (BYPASS_WORDS.some((w) => f.includes(w))) return { allowed: false, rule: "bypass_pattern" };
  }
  const warnings: EnableWarning[] = [];
  for (const r of config) {
    // A row of another known CLI does not apply; an unknown executable (a wrapper) gets every row.
    if ((cli === "claude" || cli === "codex") && r.cli !== cli) continue;
    if (!facts.exists(r.segments)) continue;
    const path = r.segments.join("/");
    if (r.severity === "refuse") return { allowed: false, rule: `repo_config:${path}` };
    if (warnings.length < 8) warnings.push({ code: "repo_config", path, cli: r.cli });
  }
  return { allowed: true, warnings };
}
