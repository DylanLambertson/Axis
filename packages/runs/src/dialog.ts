// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { basename } from "node:path";
import { cliAgentSchema } from "@axis/pty-policy";
import { RUN_COPY, DISCLOSURE_VERSION } from "./copy.js";

export interface LaunchDialog {
  readonly disclosureVersion: number;
  readonly title: string;
  readonly agentLabel: string;
  /** The executable's base name only. */
  readonly executable: string;
  /** A count, not the arguments: a configured argument may hold a token. */
  readonly argCount: number;
  readonly worktree: string;
  /** Stated in this order, all of them, so a UI cannot show a subset by accident. */
  readonly statements: readonly string[];
  readonly confirmLabel: string;
  readonly cancelLabel: string;
}

const MAX_SHOWN = 200;
// Control characters, and the bidirectional and invisible format characters that can reorder or hide text.
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff]/g;

function display(s: string): string {
  const clean = s.replace(UNSAFE, "").trim();
  return clean.length > MAX_SHOWN ? `${clean.slice(0, MAX_SHOWN)}...` : clean;
}

/**
 * The data for the launch dialog. `agent` is an `axis.cliAgents` entry; an invalid one is a caller bug and throws
 * a plain `TypeError` with a fixed message (never the offending value). The renderer draws it; the copy is in `copy.ts`.
 */
export function buildLaunchDialog(input: { readonly agent: unknown; readonly worktree: string }): LaunchDialog {
  const parsed = cliAgentSchema.safeParse(input.agent);
  if (!parsed.success || typeof input.worktree !== "string") throw new TypeError("Invalid launch dialog input");
  const a = parsed.data;
  const d = RUN_COPY.launchDialog;
  return Object.freeze({
    disclosureVersion: DISCLOSURE_VERSION,
    title: d.title,
    agentLabel: display(a.label),
    executable: display(basename(a.command[0] as string)),
    argCount: a.command.length - 1 + a.args.length,
    worktree: display(input.worktree),
    statements: Object.freeze([d.governedBy, d.canPush, d.prompts, d.environment, d.review]),
    confirmLabel: d.confirm,
    cancelLabel: d.cancel,
  });
}
