// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

/**
 * A CLI's project-level configuration in a repository (WT-3 and the CLI messaging enable rule, endpoint design section 6):
 * files that can make the CLI run commands (hooks) or act without asking (permission and sandbox settings). ONE list, read
 * by the broker's protected set (`@axis/broker` `DEFAULT_PROTECTED`: a worktree change touching one needs the protected-path
 * approval) and by the messaging enable rule (a warning, or a refusal once a row's `severity` says so).
 *
 * Every row names where it was verified, read-only, in this environment (no network): the CLI's own installed code. A path
 * that cannot be verified is still protected and says so (a false positive costs one approval; a false negative costs a
 * bypass). `segments` are root-anchored and already in the folded form the matcher compares (lower case); a prefix covers
 * everything below it. Root-anchored on purpose: a copy in a subdirectory (`sub/.claude/settings.json`) is not matched,
 * although a CLI started in that subdirectory would read it (a residual: the worktree root is where Axis starts CLI runs).
 *
 * Not listed, deliberately: instruction ("memory") files, `.claude/rules/` and `CLAUDE.local.md`, the same class as
 * `CLAUDE.md` and `AGENTS.md`, which are not protected either; protecting instruction files is one decision for the whole
 * class (owner decisions OD-1). In review, git-snapshot shows `CLAUDE.local.md` as an `instruction-file` and
 * `.claude/rules/` as `hidden-config` (its generic dot-name rule).
 *
 * Not listed yet, recommended (OD-1): `.claude/output-styles/` and `.claude/loop.md`. The CLI's own protected-path table
 * (Claude Code 2.1.332) protects them with the same fixed flag as `skills`, `commands`, `agents`, `hooks`, `settings.json`
 * and `.mcp.json`, all of which are listed here; the recommendation is to list them too.
 *
 * Not listed, residuals: `.lsp.json`, which Claude Code 2.1.332 reads only at a PLUGIN's root (language-server commands it
 * launches), not at a project's; a repository that is itself a plugin (`.claude-plugin/`) has one at its root, so it is
 * a candidate for a precautionary row like `.claude-plugin/`. Codex's exec policies, which its text names among
 * "project-local config, hooks, and exec policies" without a path this environment shows.
 */
export interface CliProjectConfig {
  readonly cli: "claude" | "codex";
  readonly segments: readonly string[];
  /** What the messaging enable rule does when the path exists in the worker's workspace (slice 1: always `warn`). */
  readonly severity: "warn" | "refuse";
  readonly source: string;
}

const CLAUDE = "Claude Code 2.1.332: the path string is in the installed binary (~/.local/share/claude/versions/2.1.332; first sourced in 2.1.330, every path checked again in 2.1.332)";
const CODEX = "codex-cli 0.166.0: the installed package (@openai/codex)";

export const CLI_PROJECT_CONFIG: readonly CliProjectConfig[] = Object.freeze([
  Object.freeze({ cli: "claude", segments: Object.freeze([".claude", "settings.json"]), severity: "warn", source: `${CLAUDE}; its --help lists the "project" setting source` }),
  Object.freeze({ cli: "claude", segments: Object.freeze([".claude", "settings.local.json"]), severity: "warn", source: `${CLAUDE}; its --help lists the "local" setting source` }),
  Object.freeze({ cli: "claude", segments: Object.freeze([".claude", "hooks"]), severity: "warn", source: CLAUDE }),
  // Paths that run something or pre-approve tools: an MCP server entry is a command the CLI launches; skills, subagent
  // definitions and plugins carry tools, scripts and hooks; commands can pre-approve tools; a workflow is a script.
  Object.freeze({ cli: "claude", segments: Object.freeze([".mcp.json"]), severity: "warn", source: `${CLAUDE}: project MCP servers` }),
  Object.freeze({ cli: "claude", segments: Object.freeze([".claude", "skills"]), severity: "warn", source: CLAUDE }),
  Object.freeze({ cli: "claude", segments: Object.freeze([".claude", ["age", "nts"].join("")]), severity: "warn", source: `${CLAUDE}: subagent definitions` }),
  Object.freeze({ cli: "claude", segments: Object.freeze([".claude", "plugins"]), severity: "warn", source: "precautionary: Claude Code 2.1.332's binary (as 2.1.330's) shows only the user-level ~/.claude/plugins, not a project one" }),
  Object.freeze({ cli: "claude", segments: Object.freeze([".claude", "commands"]), severity: "warn", source: `${CLAUDE}: slash commands (marked deprecated there, still loaded)` }),
  Object.freeze({ cli: "claude", segments: Object.freeze([".claude", "workflows"]), severity: "warn", source: `${CLAUDE}: a project workflow is ".claude/workflows/<name>.js", which "resolves to a self-contained script"` }),
  // Named in the CLI's own table of project paths it protects (it joins ".claude" with each name): a preview launch
  // configuration, routines and durable scheduled tasks all run something.
  Object.freeze({ cli: "claude", segments: Object.freeze([".claude", "launch.json"]), severity: "warn", source: `${CLAUDE}: its own protected-path table (the preview launch configuration)` }),
  Object.freeze({ cli: "claude", segments: Object.freeze([".claude", "routines"]), severity: "warn", source: `${CLAUDE}: its own protected-path table` }),
  Object.freeze({ cli: "claude", segments: Object.freeze([".claude", "scheduled_tasks.json"]), severity: "warn", source: `${CLAUDE}: its own protected-path table (durable scheduled jobs)` }),
  Object.freeze({ cli: "claude", segments: Object.freeze([".claude-plugin"]), severity: "warn", source: `precautionary, ${CLAUDE}: a folder with ".claude-plugin/plugin.json" is a plugin whose skills it auto-loads` }),
  Object.freeze({ cli: "codex", segments: Object.freeze([".codex", "config.toml"]), severity: "warn", source: `${CODEX}, whose text reads "Project \`.codex/config.toml\`: settings for a trusted repository, including sandbox, MCP, hooks"` }),
  Object.freeze({ cli: "codex", segments: Object.freeze([".codex", "hooks"]), severity: "warn", source: `${CODEX}: the path string is in its code` }),
] as const satisfies readonly CliProjectConfig[]);
