// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { ApprovalPreview, ComposerMode, ComposerRun, JsonValue, RunEvent } from "@axis/protocol";
import type { GuardedProvider } from "@axis/providers";

/**
 * The composer ports (docs/design/composer-runtime.md section 4). Handlers see `ComposerRunsService` only; the service
 * sees `ComposerEngine` only, which `bindings/agent.ts` implements over `@axis/broker` and the guarded providers. No
 * type of `@axis/broker` appears here, so the broker stays reachable from the binding alone.
 */

export interface ComposerStartInput {
  readonly workspaceId: string;
  readonly mode: ComposerMode;
  readonly prompt: string;
  readonly providerId: string;
  readonly modelId: string;
  /** The window of the attested connection that started the run: the only one that answers its approvals. */
  readonly windowId: string;
  readonly idempotencyKey?: string;
}

export interface ComposerEventsPage {
  readonly events: RunEvent[];
  readonly nextSeq: number;
  readonly complete: boolean;
  readonly available: boolean;
}

export interface ComposerRunsService {
  start(input: ComposerStartInput, signal: AbortSignal): Promise<{ readonly run: ComposerRun; readonly replayed: boolean }>;
  cancel(runId: string): ComposerRun;
  get(runId: string): ComposerRun;
  list(options: { readonly workspaceId?: string; readonly limit: number }): ComposerRun[];
  events(runId: string, afterSeq: number, limit: number): ComposerEventsPage;
}

/** A tool as the model is told about it. */
export interface ComposerToolSpec {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonValue;
}

/** What a tool call returned to the model: text, or a refusal with a closed reason (snake case). */
export type ComposerToolOutcome =
  | { readonly ok: true; readonly content: string }
  | { readonly ok: false; readonly reason: string; readonly content: string };

/** The approval progress of one tool call, for the activity stream. Paths are display text, reasons closed labels. */
export interface ComposerApprovalNote {
  readonly tool: string;
  readonly state: "requested" | "approved" | "denied" | "expired" | "withdrawn";
  readonly digest: string;
  readonly reasons: readonly string[];
  readonly paths: readonly { readonly access: "read" | "write"; readonly path: string }[];
  /** What the call will do, bound to `digest` (C8): set on `requested`, null on the later states. */
  readonly preview: ApprovalPreview | null;
}

export interface ComposerRunTools {
  readonly specs: readonly ComposerToolSpec[];
  /** Never throws for a refusal: the model is told, the run goes on. Throws only when the run must stop (audit failure). */
  invoke(name: string, input: unknown, signal: AbortSignal): Promise<ComposerToolOutcome>;
}

export interface ComposerRunContext {
  readonly runId: string;
  readonly workspaceId: string;
  readonly windowId: string;
  readonly mode: ComposerMode;
  readonly onApproval: (note: ComposerApprovalNote) => void;
}

export interface ComposerEngine {
  /** The guarded provider for an id, or undefined when none is registered. */
  provider(providerId: string): GuardedProvider | undefined;
  /**
   * Resolve the workspace's worktree now (the locator, DMN-2) and return what builds a run's tools once the run id
   * exists. Throws for a workspace that cannot be located; nothing is created then.
   */
  prepare(workspaceId: string): Promise<(run: ComposerRunContext) => ComposerRunTools>;
}
