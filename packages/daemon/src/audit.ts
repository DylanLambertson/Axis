// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { ActorId, DaemonAuditEvent, DaemonAuditSink } from "./types.js";

type Scalars = Record<string, string | number | boolean | null>;
export type AuditAction = DaemonAuditEvent["action"];
export type AuditOutcome = DaemonAuditEvent["outcome"];

export interface AuditBase {
  readonly actor: ActorId;
  /** `<contract>/<version>.<method>` */
  readonly target: string;
  readonly sideEffect: string;
  readonly connectionId: string;
  readonly correlationId: string;
  readonly workspaceId: string | null;
  readonly contractVersion: number;
}

/**
 * Builds the audit events of one request (ADR 0003 D5): decision, tier,
 * correlation id, workspace and contract version, never a payload.
 */
export class Auditor {
  /** Set once the policy decision is known. */
  tier: number;

  constructor(
    private readonly sink: DaemonAuditSink,
    private readonly base: AuditBase,
    tier: number,
    private readonly onInternalError: ((correlationId: string, error: unknown) => void) | undefined,
  ) {
    this.tier = tier;
  }

  /** Decision point: a failing sink (throw or rejection) propagates, so the request fails closed. */
  async strict(outcome: AuditOutcome, extra: Scalars, action: AuditAction = "policy.decision"): Promise<void> {
    await this.sink.append({
      actor: this.base.actor,
      action,
      target: this.base.target,
      outcome,
      payload: {
        tier: this.tier,
        sideEffect: this.base.sideEffect,
        connectionId: this.base.connectionId,
        correlationId: this.base.correlationId,
        workspaceId: this.base.workspaceId,
        contractVersion: this.base.contractVersion,
        ...extra,
      },
    });
  }

  /** After the fact (a denial, or an action that already ran): a sink failure is reported locally and changes nothing. */
  async soft(outcome: AuditOutcome, extra: Scalars, action: AuditAction = "policy.decision"): Promise<void> {
    try {
      await this.strict(outcome, extra, action);
    } catch (e) {
      this.onInternalError?.(this.base.correlationId, e);
    }
  }
}
