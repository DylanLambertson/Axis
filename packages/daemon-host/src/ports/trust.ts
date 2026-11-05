// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

export interface TrustSubject {
  readonly windowId: string;
  readonly workspaceId?: string;
}

/**
 * Live Workspace Trust, fed by the supervisor (design section 6.2). Policy ANDs it with the attested
 * `identity.trusted`, so a revoke takes effect on the next call. An unknown subject is untrusted.
 */
export interface TrustRegistry {
  isTrusted(subject: TrustSubject): boolean;
  /** Record a supervisor decision. */
  set(subject: TrustSubject, trusted: boolean): void;
}
