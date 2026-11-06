// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { composerProviderIdSchema, connectionNameSchema, destinationTextSchema } from "@axis/protocol";
import type { AdapterDescriptor, BudgetHook } from "@axis/providers";
import type { ActivityInput } from "./activity.js";

/**
 * Where a run's provider requests go (PRV-4, ticket C9). Fixed when the run starts from the descriptor of the provider
 * it selected, and carried into every `request` event. There is no fallback: a run only ever calls the provider object
 * it started with, and a descriptor that cannot be shown safely refuses the start instead of being shown differently.
 */
export interface RequestDestination {
  readonly providerId: string;
  readonly connectionId: string;
  /** The https origin, or the adapter's own description when it makes no network request: one line of display text. */
  readonly text: string;
}

/** The destination of a provider, or undefined when its descriptor is not display-safe (the start is then refused). */
export function destinationOf(descriptor: AdapterDescriptor): RequestDestination | undefined {
  try {
    const text = destinationTextSchema.safeParse(descriptor.destination.origin ?? descriptor.destination.description);
    const providerId = composerProviderIdSchema.safeParse(descriptor.providerId);
    const connectionId = connectionNameSchema.safeParse(descriptor.connectionId);
    return text.success && providerId.success && connectionId.success ? { providerId: providerId.data, connectionId: connectionId.data, text: text.data } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The run's budget, with the destination shown at the moment a request is allowed: the guard asks the budget last, after
 * its own checks, and sends the request when the answer is allow, so a request that is refused is never shown as sent.
 */
export function withDestinationEvents(budget: BudgetHook, destination: RequestDestination, emit: (event: ActivityInput) => void): BudgetHook {
  let request = 0;
  return {
    async beforeRequest(info) {
      const decision = await budget.beforeRequest(info);
      if (decision.allow) {
        request += 1;
        emit({ type: "request", request, providerId: destination.providerId, connectionId: destination.connectionId, destination: destination.text });
      }
      return decision;
    },
    recordUsage: (info) => budget.recordUsage(info),
  };
}
