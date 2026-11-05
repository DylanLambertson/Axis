// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

export interface TrustSubject {
  readonly windowId: string;
  readonly workspaceId?: string;
  /** The journal's project id; trust is held per project (design Q6), so this is the most specific level. */
  readonly projectId?: string;
}

/**
 * Live Workspace Trust for the methods that are not CLI run starts (`worktrees.create`, `git.commit`, `git.push`),
 * fed by the supervisor (design section 6.2). Policy ANDs it with the attested `identity.trusted`. An unknown
 * subject is untrusted. A CLI run start is gated by a single-use `RunTrustAttestation` instead (see `runs.ts`).
 */
export interface TrustRegistry {
  isTrusted(subject: TrustSubject): boolean;
  /** Has the supervisor explicitly withdrawn trust at any level of `subject`? A revoke refuses the next run start (TRU-2). */
  isRevoked(subject: TrustSubject): boolean;
  /** Record a supervisor decision at the most specific level the subject names (project, else workspace, else window). */
  set(subject: TrustSubject, trusted: boolean): void;
}
