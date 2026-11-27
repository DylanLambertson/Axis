// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Step 4 of docs/design/daemon-host-hooks.md: the one pinless `core.hooksPath` read, judged against the snapshot's raw
// repository-level value. Pure. The daemon (git-ops, slice S2) calls it with an `exec-result`; it lives beside the exec rules
// so the read and its judgement are tested together.

export type HooksScopeVerdict = "ok" | "hook_path_unseen";

const SCOPES = new Set(["system", "global", "local", "worktree", "command"]);

/**
 * `result` is the exec answer to `config --show-scope --get-all core.hooksPath` (or, before git 2.26, `config --get-all
 * core.hooksPath`, with `showScope` false). `snapshotRaw` is the raw last repository-level value the GIT-SNAP-1 snapshot
 * stored, or null for "unset". The winning (last) value must be byte-equal to it AND, with scopes, come from `local` or
 * `worktree`; a winning `global`, `system` or `command` value, an unknown line or any other exit refuses. Comparing the scope
 * alone is not enough: an `includeIf "hasconfig:remote.*.url:..."` matched only through global config shows `local`.
 */
export function judgeHooksPathRead(result: { readonly code: number | null; readonly stdout: string; readonly truncated: boolean }, showScope: boolean, snapshotRaw: string | null): HooksScopeVerdict {
  if (result.truncated) return "hook_path_unseen";
  if (result.code === 1 && result.stdout === "") return snapshotRaw === null ? "ok" : "hook_path_unseen";
  if (result.code !== 0 || !result.stdout.endsWith("\n")) return "hook_path_unseen";
  const lines = result.stdout.slice(0, -1).split("\n");
  let last: { scope: string | undefined; value: string } | undefined;
  for (const line of lines) {
    if (!showScope) {
      last = { scope: undefined, value: line };
      continue;
    }
    const tab = line.indexOf("\t");
    const scope = tab < 0 ? "" : line.slice(0, tab);
    // A value with a newline in it would split into a line without a known scope: refused, never guessed.
    if (!SCOPES.has(scope)) return "hook_path_unseen";
    last = { scope, value: line.slice(tab + 1) };
  }
  // An empty value makes git look for `/<hook>`; it is refused on the raw value, never guessed (§5 step 4).
  if (last === undefined || snapshotRaw === null || snapshotRaw === "") return "hook_path_unseen";
  if (showScope && last.scope !== "local" && last.scope !== "worktree") return "hook_path_unseen";
  return last.value === snapshotRaw ? "ok" : "hook_path_unseen";
}
