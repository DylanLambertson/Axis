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
const CLAUDE_HELP = "Claude Code 2.1.332 --help"; // first sourced in 2.1.330; every row checked again in 2.1.332
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
  row("claude.plugin-url", "claude", ["--plugin-url"], CLAUDE_HELP),
  // A feature switch is the flag form of `-c features.<name>=...` (review 4 SF11): `--disable` can turn an approval feature off.
  row("codex.feature", "codex", ["--enable", "--disable"], CODEX_HELP),
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
const WRAPPERS: ReadonlySet<string> = new Set(["env", "sudo", "doas", "su", "runuser", "nice", "nohup", "timeout", "time", "stdbuf", "xargs", "setsid", "chrt", "ionice", "flock", "npx", "npm", "pnpm", "yarn", "bunx", "uvx", "pipx"]);
/**
 * Environment assignments in a wrapper's arguments (`env A=b`), INVERTED (review 4 SF11: a
 * planted `$HOME/.codex/config.toml` behind `env HOME=/x` runs the CLI with approvals and the sandbox off). Only these names
 * are allowed; a configuration home (`HOME`, `XDG_*`, `CODEX_*`, `CLAUDE_*`) is `config_home`, any other `env_assignment`.
 */
const ENV_SAFE = (name: string): boolean => ["LANG", "TERM", "NO_COLOR", "TZ", "COLORTERM"].includes(name) || /^LC_[A-Z]+$/.test(name);
const CONFIG_HOME = /^(HOME|XDG_[A-Z_]+|CODEX_[A-Z0-9_]*|CLAUDE_[A-Z0-9_]*)$/;

/**
 * The flags an ENABLING launch may carry, per CLI, INVERTED (review 4 SF11: refusing bad flags one by one never ends).
 * Sourced from the installed `--help` (Claude Code 2.1.332, codex-cli 0.166.0) and kept small: model selection, printing
 * and output format, verbosity, version and help, and for Codex the judged `-c`, `-a` and `-s`. Every other token that
 * starts with `-` is `unknown_flag`, at enable and at mint; the rows above still refuse their own flags by name first.
 * `value`: "none" (a switch), "any" (a plain value of at most 64 characters), "config" (judged by `codexConfigRule`),
 * or the exact values allowed.
 */
interface SafeFlag {
  readonly flags: readonly string[];
  readonly value: "none" | "any" | "config" | readonly string[];
}
const SAFE_FLAGS: Readonly<Record<string, readonly SafeFlag[]>> = Object.freeze({
  claude: Object.freeze<SafeFlag[]>([
    { flags: ["--model"], value: "any" },
    { flags: ["-p", "--print"], value: "none" },
    { flags: ["--output-format"], value: ["text", "json", "stream-json"] },
    { flags: ["--verbose"], value: "none" },
    { flags: ["-v", "--version"], value: "none" },
    { flags: ["-h", "--help"], value: "none" },
  ]),
  codex: Object.freeze<SafeFlag[]>([
    { flags: ["-m", "--model"], value: "any" },
    { flags: ["-c", "--config"], value: "config" },
    { flags: ["-a", "--ask-for-approval"], value: ["on-request"] },
    { flags: ["-s", "--sandbox"], value: ["read-only", "workspace-write"] },
    { flags: ["-h", "--help"], value: "none" },
    { flags: ["-V", "--version"], value: "none" },
  ]),
});

/** The first flag of `args` outside the safe lists of `clis`, as a rule, and the indexes the safe flags took as values. */
function flagScan(clis: ReadonlySet<string>, args: readonly string[]): { readonly rule: string | undefined; readonly values: ReadonlySet<number> } {
  const safe = [...clis].flatMap((c) => SAFE_FLAGS[c] ?? []);
  const values = new Set<number>();
  for (let i = 0; i < args.length; i++) {
    if (values.has(i)) continue;
    const tok = args[i] as string;
    if (!tok.startsWith("-") || tok === "-") continue; // a positional argument (the prompt, a subcommand)
    let ok = false;
    for (const f of safe) {
      for (const flag of f.flags) {
        if (f.value === "none") {
          if (tok === flag) ok = true;
          continue;
        }
        const { hit, value } = flagValue(flag, args, i);
        if (!hit) continue;
        if (tok === flag) values.add(i + 1);
        if (value === undefined) return { rule: "unknown_flag", values };
        if (f.value === "config") {
          const r = codexConfigRule(value);
          if (r !== undefined) return { rule: r, values };
        } else if (f.value === "any" ? !/^[A-Za-z0-9._:/-]{1,64}$/.test(value) : !f.value.includes(fold(value))) {
          return { rule: "unknown_flag", values };
        }
        ok = true;
      }
      if (ok) break;
    }
    if (!ok) return { rule: "unknown_flag", values };
  }
  return { rule: undefined, values };
}

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
  // The union of the rows of every known CLI the name or the real path names (review 2 SF9); none known: every CLI's rows.
  // A known name whose real path is a wrapper or an interpreter is a wrapper (review 3 N12: `/r/codex -> /usr/bin/env`).
  const realIsWrapper = facts.executableReal !== undefined && (WRAPPERS.has(cliOf(facts.executableReal)) || interpreterOf(facts.executableReal) !== undefined);
  // A known name is trusted only when its real path is that CLI itself (review 5 N24, tightened in review 6 N28 and N29), in
  // exactly one of these layouts; a link named after a CLI whose real path is anything else could run anything, so it is
  // refused, not trusted by name:
  // - the real path's own name is a known CLI (`codex`, `codex.js`: the union of rows of review 2 SF9 still applies);
  // - a version-number file inside a directory named after the CLI, matched as a whole path segment in any case (Claude's
  //   native installer: `.../claude/versions/2.1.332`); any other file name there is not the CLI;
  // - Claude Code's npm package script, by its exact path (`.../@anthropic-ai/claude-code/cli.js`, as the package publishes
  //   it; no npm-installed copy was present to check here).
  // Anything else is refused, a snap's `snapd` included (a residual: such an install cannot enable messaging).
  const nameOnly = cliOf(executable);
  if (KNOWN_CLIS.has(nameOnly) && facts.executableReal !== undefined && !realIsWrapper) {
    const real = facts.executableReal.replace(/\\/g, "/");
    const parts = real.split("/");
    const file = parts.pop() ?? "";
    const dirs = parts.map((d) => d.toLowerCase());
    const realNamed = KNOWN_CLIS.has(cliOf(real));
    const versioned = dirs.includes(nameOnly) && /^[0-9]+(\.[0-9]+)+$/.test(file);
    const npmClaude = nameOnly === "claude" && /\/@anthropic-ai\/claude-code\/cli\.js$/.test(real);
    if (!realNamed && !versioned && !npmClaude) return { allowed: false, rule: "wrapper_unparsed" };
  }
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
  const scan = flagScan(clis, args);
  if (scan.rule !== undefined) return { allowed: false, rule: scan.rule };
  // A wrapper's environment prefix: only the listed names (review 4 SF11). For a known CLI an `A=b` token is a positional
  // argument (the prompt), not an assignment.
  if (knownNames.length === 0) {
    for (let i = 0; i < args.length; i++) {
      if (scan.values.has(i)) continue;
      const tok = args[i] as string;
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(tok);
      if (m === null || ENV_SAFE(m[1] as string)) continue;
      return { allowed: false, rule: CONFIG_HOME.test(m[1] as string) ? "config_home" : "env_assignment" };
    }
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
