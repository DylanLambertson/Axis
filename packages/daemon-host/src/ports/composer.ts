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
  /** The Axis agent record the run is started for (PV-G4), recorded as the run's `agent_id`. */
  readonly worker?: string;
  /**
   * Who started the run, built by the handler from the attested identity only, never from a request field (PV-K1e). REQUIRED, so
   * a caller that forgets it does not compile (a missing initiator must never mean "the user" by default). A plugin start is
   * recorded as `plugin:<id>` and is tainted before its first model call.
   */
  readonly initiator: RunInitiator;
  /**
   * IAC-T receipts the run takes before its first model call (PV-T1 slice 2b: a Start of an untrusted task, source 5).
   * Internal to the daemon, never on the wire: the run's tools are built only after every receipt is recorded, and a
   * receipt that cannot be recorded ends the run START_FAILED with nothing sent.
   */
  readonly taint?: readonly unknown[];
}

export type RunInitiator = { readonly kind: "user" } | { readonly kind: "plugin"; readonly pluginId: string; readonly generation: number };

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

/**
 * The run must end now with a closed reason (C3, WT-2 broker side): a command changed the repository's hooks or common
 * directory, or that could not be checked (`GIT_DRIFT_UNJUDGED` when the check could not finish and saw no addition or modification, C7-F2). Thrown by
 * `ComposerRunTools.invoke`; the loop ends the run FAILED with `reason`.
 */
export const RUN_HALT_REASONS = ["GIT_DRIFT", "GIT_DRIFT_UNJUDGED"] as const;
export class ComposerRunHalt extends Error {
  constructor(readonly reason: (typeof RUN_HALT_REASONS)[number]) {
    super("the composer run was halted");
    this.name = "ComposerRunHalt";
  }
}

/**
 * WT-2 for a composer run (ticket C3, review c3 r1 SF-1): ONE baseline per run, taken before its first command and never
 * replaced, and every later check compares the repository with it. A change that lands between two commands (a detached
 * child of an earlier command, anything else) is therefore still drift at the next check, never absorbed into a new baseline.
 * Held per RUN (one composer run per workspace at a time); the oldest goes first past `maxHeld`, so a run whose baseline was
 * pushed out finds none and its check throws (the caller reads that as drift).
 */
/** The run and the worktree a guard's baseline is taken over (the shape of `@axis/runs` `SnapshotContext`). */
export interface GuardContext {
  readonly runId: string;
  readonly workspaceId: string;
  readonly worktree: { readonly workTree: string; readonly gitDir: string };
}

export interface RunRepositoryGuard {
  /** Takes the run's baseline; refuses (throws) when it cannot be judged, or when the run already has one. */
  baseline(ctx: GuardContext, signal?: AbortSignal): Promise<void>;
  /**
   * The repository now against the run's baseline, which is kept. Throws when there is none or nothing can be judged.
   * `unjudged` marks a drift verdict whose final take stopped at a bound and whose diff holds no addition or modification (removals may be real): still drift (the run halts), with its own reason so it can be told apart (C7-F2). `signal` (the run's)
   * stops a take when the run is cancelled; the check then rejects, which is never a clean answer.
   */
  check(runId: string, signal?: AbortSignal): Promise<{ readonly drift: boolean; readonly unjudged?: boolean }>;
  /** Drops the run's baseline (its end). */
  release(runId: string): void;
}

export interface ComposerRunTools {
  readonly specs: readonly ComposerToolSpec[];
  /** Never throws for a refusal: the model is told, the run goes on. Throws only when the run must stop (audit failure, or `ComposerRunHalt`). */
  invoke(name: string, input: unknown, signal: AbortSignal): Promise<ComposerToolOutcome>;
  /**
   * The drift notice before a model turn (policies section 3.4, C2): the paths the run saw that changed outside it since
   * its last turn, as untrusted-labelled text with no content, or undefined when nothing changed. Never throws.
   */
  drift?(signal: AbortSignal): Promise<string | undefined>;
  /**
   * WT-2 before a model turn that follows tool calls, and before the run ends `REVIEWING`: throws `ComposerRunHalt` when the
   * repository's hooks or common dir changed since the run's first command (or cannot be judged). Nothing else throws.
   */
  guard?(signal: AbortSignal): Promise<void>;
  /**
   * Messages for the run at a turn boundary (PV-M3 slice 2, inter-agent-communication.md section 6.1): a framed, escaped
   * block for the next turn, or undefined. The run is tainted before the block is returned when any message is not the
   * user's. The loop calls `ack` once the next provider request (which carries the block) succeeded, and `release` when
   * it failed or the run ended first. Throws when the delivery could not be recorded (the content is withheld and the
   * run must stop).
   */
  deliver?(signal: AbortSignal): Promise<{ readonly text: string; ack(): unknown; release(): unknown } | undefined>;
  /** The run ended (any state): releases what the tools hold for it. Never throws. */
  close?(): void;
}

export interface ComposerRunContext {
  readonly runId: string;
  readonly workspaceId: string;
  readonly windowId: string;
  readonly mode: ComposerMode;
  readonly onApproval: (note: ComposerApprovalNote) => void;
  /** Receipts the run takes before its tools are returned (`ComposerStartInput.taint`). */
  readonly receipts?: readonly unknown[];
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
