// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { DaemonError } from "@axis/daemon";

/**
 * The closed refusals of `axis.terminals/1` (terminals-contract.md section 7). Every message is a constant: nothing a path, the
 * shell, the environment or a caught error said reaches the wire. The trust gate's own refusals pass through unchanged.
 */
const TEXT = {
  not_found: ["E_NOT_FOUND", "No such workspace or terminal."],
  shell_unavailable: ["E_UNAVAILABLE", "No usable shell is configured for terminals."],
  too_many_terminals: ["E_CONFLICT", "This workspace has too many terminals open."],
  needs_attention: ["E_UNAVAILABLE", "This workspace needs attention and is unavailable."],
  cancelled: ["E_CANCELLED", "The request was cancelled."],
  spawn_failed: ["E_UNAVAILABLE", "The terminal could not be started."],
} as const;

export type TerminalRefusal = keyof typeof TEXT;

export function terminalFailure(reason: TerminalRefusal): DaemonError {
  const [code, text] = TEXT[reason];
  return reason === "not_found" || reason === "cancelled" ? new DaemonError(code, text) : new DaemonError(code, text, { reason });
}
