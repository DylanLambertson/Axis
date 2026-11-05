// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

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
}

/** Passed to every port method that can take time. Ports stop work promptly when `signal` aborts. */
export interface PortContext {
  readonly caller: Caller;
  readonly signal: AbortSignal;
}
