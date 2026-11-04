// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { dirname, join } from "node:path";
import { displayValue, escapeDisplay, secretNamed } from "./display.js";
import { record, type Ctx } from "./entry.js";
import { parseGitConfig } from "./gitconfig.js";
import { locate, resolveUserPath } from "./paths.js";
import { PATH_SETTINGS, classifySetting } from "./settings.js";
import type { Setting } from "./types.js";

/** A path some setting points git at: read and hashed whatever its value looks like. */
export interface PathTarget {
  readonly kind: "hooks" | "attributes";
  readonly path: string;
}

export interface ConfigInput {
  readonly commonDir: string;
  readonly worktreePath: string;
  readonly worktreeRoots: readonly string[];
  /** Directory names under `$GIT_COMMON_DIR/worktrees`. */
  readonly worktreeNames: readonly string[];
}

interface Queued {
  readonly id: string;
  readonly path: string;
  readonly depth: number;
}

/**
 * Reads `config`, every `config.worktree`, and every file they include (all `includeIf` conditions are assumed true:
 * a superset is safe, a guess is not). Returns the paths that path-valued settings name. Settings are derived from
 * the files, so they never add anything the file hashes do not cover.
 */
export async function collectConfigs(ctx: Ctx, input: ConfigInput): Promise<PathTarget[]> {
  const queue: Queued[] = [
    { id: "config", path: join(input.commonDir, "config"), depth: 0 },
    { id: "config.worktree", path: join(input.commonDir, "config.worktree"), depth: 0 },
  ];
  for (const name of input.worktreeNames) {
    queue.push({
      id: `worktrees/${escapeDisplay(name)}/config.worktree`,
      path: join(input.commonDir, "worktrees", name, "config.worktree"),
      depth: 0,
    });
  }
  const targets: PathTarget[] = [];
  const queued = new Set(queue.map((q) => q.path));
  let includes = 0;
  let settingsFull = false;

  for (let qi = 0; qi < queue.length; qi++) {
    const item = queue[qi] as Queued;
    const { read } = await record(ctx, item.id, "config", item.path, { parse: true });
    if (read.bytes === null || read.kind !== "file") continue;
    const parsed = parseGitConfig(read.bytes.toString("utf8"), ctx.limits.maxSettings * 8);
    if (parsed.truncated) ctx.incomplete.push({ id: item.id, reason: "too many entries to parse", blocking: true });

    for (const e of parsed.entries) {
      const isInclude = (e.section === "include" && e.subsection === null) || e.section === "includeif";
      if (isInclude && e.name === "path" && e.value !== null) {
        const abs = resolveUserPath(e.value, dirname(item.path), ctx.homeDir);
        if (abs === null) {
          ctx.incomplete.push({ id: item.id, reason: "include path git must expand", blocking: true });
        } else if (!queued.has(abs)) {
          if (item.depth + 1 > ctx.limits.maxIncludeDepth) {
            ctx.incomplete.push({ id: item.id, reason: "include depth limit", blocking: true });
          } else if (++includes > ctx.limits.maxIncludeFiles) {
            ctx.incomplete.push({ id: item.id, reason: "include file limit", blocking: true });
          } else {
            queued.add(abs);
            queue.push({ id: `include:${escapeDisplay(abs)}`, path: abs, depth: item.depth + 1 });
          }
        }
      }
      const cls = classifySetting(e.section, e.subsection, e.name);
      if (cls === null) continue;
      if (ctx.settings.length >= ctx.limits.maxSettings) {
        settingsFull = true;
        continue;
      }
      const key = `${e.section}${e.subsection === null ? "" : `.${displayValue(e.subsection, 200)}`}.${e.name}`;
      const value = e.value === null ? null : secretNamed(e.name) ? "[REDACTED]" : displayValue(e.value);
      let note: Setting["note"] = null;
      const pathKind = e.subsection === null ? PATH_SETTINGS.get(`${e.section}.${e.name}`) : undefined;
      if (pathKind !== undefined && e.value !== null && e.value !== "") {
        const abs = resolveUserPath(e.value, input.worktreePath, ctx.homeDir);
        if (abs === null) {
          note = "unresolved";
          ctx.incomplete.push({ id: item.id, reason: `${e.section}.${e.name} git must expand`, blocking: true });
        } else {
          note = await locate(abs, input.worktreeRoots);
          targets.push({ kind: pathKind, path: abs });
        }
      }
      ctx.settings.push({ key, value, origin: item.id, line: e.line, label: cls.label, severity: cls.severity, note });
    }
  }
  if (settingsFull) ctx.incomplete.push({ id: "settings", reason: "setting list truncated", blocking: false });
  return targets;
}
