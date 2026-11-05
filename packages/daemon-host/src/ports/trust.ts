// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

export interface TrustSubject {
  readonly windowId: string;
  readonly workspaceId?: string;
}

/**
 * Live Workspace Trust, fed by the supervisor (design section 6.2). Policy ANDs it with the attested `identity.trusted`
 * for `worktrees.create`, `restoreFromRunBase`, `git.commit` and `git.push`, and consults it only for an explicit revoke
 * on a CLI run start (the start itself is gated by a single-use `RunTrustAttestation`, see `runs.ts`). An unknown
 * subject is untrusted. There is no project level: a connection identity carries no project id, so the policy could
 * never name one (the supervisor's `trust.set` is `{ windowId, workspaceId?, trusted }`).
 */
export interface TrustRegistry {
  isTrusted(subject: TrustSubject): boolean;
  /** Has the supervisor explicitly withdrawn trust at any level of `subject`? A revoke refuses the next run start (TRU-2). */
  isRevoked(subject: TrustSubject): boolean;
  /** Record a supervisor decision at the most specific level the subject names (workspace, else window). */
  set(subject: TrustSubject, trusted: boolean): void;
}
