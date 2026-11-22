// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

import type { TrustCall } from "../gate/project-trust.js";

/** Removes a listener or subscription. Calling it twice is harmless. */
export type Unsubscribe = () => void;

/**
 * Who a port call acts for. It is built by a handler from the attested connection (`ctx.identity`), never from a
 * request payload, and is what the journal records as `createdBy`.
 */
export interface Caller {
  readonly actor: string;
  readonly connectionId: string;
  readonly windowId: string;
  /** The gated-call form of the same identity (`trustCallOf`), where a port may call the project trust gate; absent: it refuses. */
  readonly trust?: TrustCall;
}

/** Passed to every port method that can take time. Ports stop work promptly when `signal` aborts. */
export interface PortContext {
  readonly caller: Caller;
  readonly signal: AbortSignal;
  /**
   * The opaque, single-use capability a spent approval produced for this call (`ctx.approved.capability` of the
   * handler), when there is one. Only the binding that understands it reads it; a port that has no use for it ignores
   * it. A handler passes it through and never builds one.
   */
  readonly confirmation?: unknown;
  /**
   * The project trust gate for this call (project-registration-and-trust.md §5.4), bound to the caller's window and signal: a
   * gated port calls it inside its project mutex right before its first write and spends the ticket. Absent: the port refuses.
   */
  readonly trust?: (scope: { readonly projectId: string; readonly workspaceId?: string }) => Promise<unknown>;
}
