// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The only place Agent-view run copy lives (ROADMAP Phase 1a gate: the launch dialog and the run row say the CLI is
// governed by its own permissions and can push; the copy never says "sandbox" or "secure"). Threat model CLI-1.
import type { RunStatus, WorkspaceRunStatus } from "./status.js";

/** Bumped whenever the disclosure wording changes; recorded in the start audit row. */
export const DISCLOSURE_VERSION = 2;

function deepFreeze<T extends object>(o: T): T {
  for (const v of Object.values(o)) if (typeof v === "object" && v !== null) deepFreeze(v);
  return Object.freeze(o);
}

export const RUN_COPY = deepFreeze({
  launchDialog: {
    title: "Start a CLI run",
    governedBy: "This run is governed by the CLI's own permissions. Axis does not approve, limit or audit what the CLI does.",
    canPush: "The CLI runs with your credentials and can push to your remotes without asking Axis.",
    prompts: "The CLI's own permission prompts appear in its terminal. Answer them there.",
    environment: "Axis removes its own editor variables (VSCODE_*, ELECTRON_*, askpass and editor hooks) from the CLI's environment. Your login environment, including any tokens in it, is passed through.",
    review: "Changes appear in diff review. Commit and push from Axis are unavailable while the run is active.",
    confirm: "Start run",
    cancel: "Cancel",
  },
  runRow: {
    governedBy: "Governed by the CLI's own permissions",
    stop: "Stop run",
  },
  refusals: {
    commitWhileRunning: "Stop the agent run to commit",
    pushWhileRunning: "Stop the agent run to push",
    untrusted: "Trust this repository to run a CLI in this workspace",
    limit: "Too many CLI runs are active on this device. Stop one to start another.",
  },
  status: {
    starting: "starting",
    running: "running",
    quiet: "quiet (may be waiting for input)",
    finished: "exited",
    failed: "failed",
    killed: "stopped",
    interrupted: "interrupted by restart",
    stopping: "stopping (process not confirmed gone)",
  } satisfies Record<RunStatus, string>,
  workspaceStatus: {
    idle: "idle",
    running: "running",
    quiet: "quiet (may be waiting for input)",
    failed: "failed",
    done: "done",
  } satisfies Record<WorkspaceRunStatus, string>,
});

/** Every string in `RUN_COPY`, for the wording test. */
export function* copyStrings(node: unknown = RUN_COPY): Generator<string> {
  if (typeof node === "string") yield node;
  else if (typeof node === "object" && node !== null) for (const v of Object.values(node)) yield* copyStrings(v);
}
