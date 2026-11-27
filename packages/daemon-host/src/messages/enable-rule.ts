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
  // A settings or profile file named in argv can switch auto-approval on from content the rule never reads (review 1:
  // decided by master, 2026-11-26). `-p` is Codex's profile only: in Claude Code `-p` is print.
  row("claude.settings", "claude", ["--settings"], CLAUDE_HELP),
  // What configuration, tools and plugins load (review 3 N17): each changes what the CLI may do, from content not read here.
  row("claude.mcp-config", "claude", ["--mcp-config"], CLAUDE_HELP),
  row("claude.setting-sources", "claude", ["--setting-sources"], CLAUDE_HELP),
  row("claude.subagents", "claude", [["--age", "nts"].join("")], CLAUDE_HELP),
  row("claude.plugin-dir", "claude", ["--plugin-dir"], CLAUDE_HELP),
  row("codex.profile", "codex", ["--profile", "-p"], CODEX_HELP),
]);
// No Gemini rows: Gemini is not installed in the environment the table was sourced in (only a wrapper with no binary), so
// its flags are left to the pattern rule (`yolo`, `bypass`, ...) until a row can be verified in its own help.

/** Words that mark a bypass in any CLI's argument (decision 2: fail closed for what the table does not know), folded. */
export const BYPASS_WORDS: readonly string[] = Object.freeze([
  "dangerously", "yolo", "bypass", "skip-permissions", "no-confirm", "auto-approve", "full-auto", "approval-mode", "danger-full-access", "no-sandbox", "sandbox=false",
]);

/** The most warnings one answer carries (the protocol's bound); more refuse the enable and the mint. */
export const MAX_WARNINGS = 8;
export type EnableWarning = { readonly code: "repo_config"; readonly path: string; readonly cli: string };
export type EnableDecision = { readonly allowed: false; readonly rule: string } | { readonly allowed: true; readonly warnings: readonly EnableWarning[] };

/** The facts the rule decides over. `argv` is the whole launch argv, `argv[0]` the executable. */
export interface EnableFacts {
  readonly argv: readonly string[];
  /** The executable's real path when the host resolved it (a link to a versioned binary): its base name counts too. */
  readonly executableReal?: string;
  readonly bypassesPrompts: boolean;
  /** Whether the root-relative path (folded segments) exists in the worker's workspace. */
  readonly exists: (segments: readonly string[]) => boolean;
}

/** Folded for comparison: lower case, `_` read as `-` in words, quotes and spaces of a TOML value dropped. */
const fold = (s: string): string => s.toLowerCase().replace(/["'\s]/g, "");
/** Which CLI an executable is: its base name without a Windows extension; anything else is unknown (the pattern rule still applies). */
export function cliOf(executable: string): string {
  const base = (executable.split(/[\\/]/).pop() ?? "").replace(/[. ]+$/, "");
  return base.toLowerCase().replace(/\.(exe|com|cmd|bat|ps1|js|mjs|cjs)$/, "");
}

const KNOWN_CLIS: ReadonlySet<string> = new Set(["claude", "codex"]);

/**
 * Shells and interpreters (review 2 SF8), by base name with any version suffix dropped (`python3.12`, `ruby3.2`, `php8`).
 * As the executable, with inline code they are refused (`wrapper_unparsed`): the CLI and its flags would be inside a string.
 * Named in ANY argument of an executable that is not a known CLI (`env bash -c`, `nice python3 -c`, `sudo sh -c`), they are
 * refused too. EXACTLY these names; any other interpreter is a residual (messages-contract section 14).
 */
export const INTERPRETERS: readonly string[] = Object.freeze([
  "sh", "bash", "zsh", "dash", "ksh", "ash", "fish", "busybox", "cmd", "powershell", "pwsh", "python", "pythonw", "py",
  "node", "nodejs", "deno", "bun", "perl", "ruby", "php", "lua", "luajit", "awk", "gawk", "mawk", "nawk", "rscript", "osascript", "tclsh",
]);
const INTERP = new Set(INTERPRETERS);
/** An executable's interpreter name, or undefined: the CLI-style name with a trailing version (`3.12`, `8`) dropped. */
const interpreterOf = (exe: string): string | undefined => {
  const n = cliOf(exe).replace(/[0-9][0-9.]*$/, "");
  return INTERP.has(n) ? n : undefined;
};
/**
 * Inline-code arguments, exactly: `-c`, `-e`, `-r` and short clusters ending in them (`-lc`, `-ec`, `-Ic`), the value
 * attached to `-c` or `-e` (`-cCODE`), `--eval`, `--command`, `--print` (with or without `=`), PowerShell's `-Command`,
 * `-EncodedCommand`, `-enc`, `-ec` in any case, cmd's `/c` and `/k`, `env`'s `-S` and `--split-string`, and a bare `eval`
 * (`deno eval`). For an `awk`-family executable every program argument is inline code.
 */
export function isInlineCode(arg: string): boolean {
  return (
    /^-[a-z]{0,3}[cer]$/i.test(arg) ||
    /^-[ce][^-]/i.test(arg) ||
    /^--(eval|command|print)(=|$)/i.test(arg) ||
    /^-(command|encodedcommand|enc|ec)$/i.test(arg) ||
    /^\/[ck]$/i.test(arg) ||
    /^-[a-z]{0,3}s$/i.test(arg) || arg.startsWith("--split-string") ||
    arg === "eval"
  );
}

/**
 * Codex `-c key=value` overrides, INVERTED (review 3 SF10: more keys than two switch off approvals or the sandbox, and a list
 * of bad keys never ends). Only these keys are allowed, each sourced in the installed codex-cli 0.166.0: `model` (its own
 * `--help` example) and `model_reasoning_effort` (its package text), with a plain scalar value; and the two security keys
 * with their safe values from its `--help`. Every other key, every dotted key, and any value with `{`, `[`, a backslash or a
 * non-ASCII character is refused as `config_unparsed`: a fixed reason, so no key a caller wrote reaches the audit row.
 */
const CODEX_SAFE: ReadonlyMap<string, readonly string[] | "scalar"> = new Map<string, readonly string[] | "scalar">([
  ["model", "scalar"],
  ["model_reasoning_effort", "scalar"],
  ["approval_policy", ["on-request"]],
  ["sandbox_mode", ["read-only", "workspace-write"]],
]);
function codexConfigRule(kv: string): string | undefined {
  if (/[\\{[]|[^\x20-\x7e]/.test(kv)) return "config_unparsed";
  const eq = kv.indexOf("=");
  if (eq < 0) return "config_unparsed";
  const key = kv.slice(0, eq).trim();
  const allowed = CODEX_SAFE.get(key);
  if (allowed === undefined) return "config_unparsed";
  const raw = kv.slice(eq + 1).trim();
  const quoted = /^(["'])([^"']*)\1$/.exec(raw);
  if (quoted === null && /["']/.test(raw)) return "config_unparsed";
  const value = quoted === null ? raw : (quoted[2] as string);
  if (allowed === "scalar") return /^[A-Za-z0-9._:-]{1,64}$/.test(value) ? undefined : "config_unparsed";
  return allowed.includes(value) ? undefined : `codex.config.${key}`;
}

/** Programs that run another program (review 3 N12): a known CLI's name whose real path is one of these is a wrapper. */
const WRAPPERS: ReadonlySet<string> = new Set(["env", "sudo", "doas", "su", "runuser", "nice", "nohup", "timeout", "time", "stdbuf", "xargs", "npx", "npm", "pnpm", "yarn", "bunx", "uvx", "pipx"]);
/** An environment assignment in the launch arguments that moves a CLI's whole configuration elsewhere (review 3 N17). */
const CONFIG_HOME = /^(CODEX_HOME|CLAUDE_CONFIG_DIR)=/;

/**
 * One argument against one flag: `--flag`, `--flag=value`, `--flag value`, and for a short flag also with the value attached
 * (`-anever`, `-capproval_policy=never`: how the CLIs' parsers read it, review 1 SF1). The value, if any.
 */
function flagValue(flag: string, args: readonly string[], i: number): { readonly hit: boolean; readonly value: string | undefined } {
  const tok = args[i] as string;
  if (tok === flag) return { hit: true, value: args[i + 1] };
  if (tok.startsWith(`${flag}=`)) return { hit: true, value: tok.slice(flag.length + 1) };
  if (flag.length === 2 && !tok.startsWith("--") && tok.startsWith(flag) && tok.length > 2) return { hit: true, value: tok.slice(2) };
  return { hit: false, value: undefined };
}

/** The table row an argv matches, if any. `clis`: the rows that apply (every CLI's when the executable is not a known one). */
function tableHit(clis: ReadonlySet<string>, args: readonly string[]): FlagRow | undefined {
  for (let i = 0; i < args.length; i++) {
    for (const r of BYPASS_FLAGS) {
      if (!clis.has(r.cli)) continue;
      for (const flag of r.flags) {
        const { hit, value } = flagValue(flag, args, i);
        if (hit && (r.value === undefined || (value !== undefined && fold(value) === fold(r.value)))) return r;
      }
    }
  }
  return undefined;
}

/** `config`: the repository-configuration rows (the shared list; a test passes its own to reach a `refuse` row). */
export function decideCliMessaging(facts: EnableFacts, config: readonly CliProjectConfig[] = CLI_PROJECT_CONFIG): EnableDecision {
  if (facts.bypassesPrompts) return { allowed: false, rule: "user_marked" };
  if (facts.argv.length === 0 || facts.argv[0] === "") return { allowed: false, rule: "empty_argv" };
  const [executable = "", ...args] = facts.argv;
  const exes = [executable, ...(facts.executableReal === undefined ? [] : [facts.executableReal])];
  if (args.some((a) => CONFIG_HOME.test(a))) return { allowed: false, rule: "config_home" };
  // The union of the rows of every known CLI the name or the real path names (review 2 SF9); none known: every CLI's rows.
  // A known name whose real path is a wrapper or an interpreter is a wrapper (review 3 N12: `/r/codex -> /usr/bin/env`).
  const realIsWrapper = facts.executableReal !== undefined && (WRAPPERS.has(cliOf(facts.executableReal)) || interpreterOf(facts.executableReal) !== undefined);
  const knownNames = realIsWrapper ? [] : [...new Set(exes.map(cliOf).filter((n) => KNOWN_CLIS.has(n)))];
  const clis: ReadonlySet<string> = knownNames.length === 0 ? KNOWN_CLIS : new Set(knownNames);
  for (const exe of exes) {
    const interp = interpreterOf(exe);
    if (interp === undefined) continue;
    if (interp.endsWith("awk") || args.some(isInlineCode)) return { allowed: false, rule: "wrapper_unparsed" };
  }
  // Not a known CLI (a wrapper): any interpreter named, or any inline-code argument, in ANY position (review 2 SF8).
  if (knownNames.length === 0 && args.some((a) => interpreterOf(a) !== undefined || isInlineCode(a))) return { allowed: false, rule: "wrapper_unparsed" };
  if (clis.has("codex")) {
    for (let i = 0; i < args.length; i++) {
      for (const flag of ["-c", "--config"]) {
        const { hit, value } = flagValue(flag, args, i);
        const rule = hit && value !== undefined ? codexConfigRule(value) : undefined;
        if (rule !== undefined) return { allowed: false, rule };
      }
    }
  }
  const hit = tableHit(clis, args);
  if (hit !== undefined) return { allowed: false, rule: hit.id };
  for (const a of args) {
    const f = fold(a).replace(/_/g, "-");
    if (BYPASS_WORDS.some((w) => f.includes(w))) return { allowed: false, rule: "bypass_pattern" };
  }
  const warnings: EnableWarning[] = [];
  for (const r of config) {
    // The rows of the CLIs that apply (every CLI's for a wrapper).
    if (!clis.has(r.cli)) continue;
    if (!facts.exists(r.segments)) continue;
    if (r.severity === "refuse") return { allowed: false, rule: "repo_config" }; // never a path in the audit row
    warnings.push({ code: "repo_config", path: r.segments.join("/"), cli: r.cli });
  }
  // More than the answer can carry: refused, never truncated (review 2 SF6: a dropped warning is a file never confirmed).
  if (warnings.length > MAX_WARNINGS) return { allowed: false, rule: "too_many_repo_files" };
  return { allowed: true, warnings };
}
