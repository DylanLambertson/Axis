// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

export interface TrustSubject {
  readonly windowId: string;
  readonly workspaceId?: string;
}

/**
 * Live Workspace Trust for the methods that are not CLI run starts (`worktrees.create`, `git.commit`, `git.push`),
 * fed by the supervisor (design section 6.2). Policy ANDs it with the attested `identity.trusted`. An unknown
 * subject is untrusted. A CLI run start is gated by a single-use `RunTrustAttestation` instead (see `runs.ts`).
 */
export interface TrustRegistry {
  isTrusted(subject: TrustSubject): boolean;
  /** Record a supervisor decision. */
  set(subject: TrustSubject, trusted: boolean): void;
}
