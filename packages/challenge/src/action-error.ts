// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { errorSchema } from "@axis/protocol";
import { ChallengeError } from "./errors.js";

const GENERIC = "The action failed after the confirmation was spent";

/**
 * What `consume` throws when the action throws. Only a protocol-shaped error
 * (a code, a retryable flag and a message that pass `errorSchema`) keeps its
 * code and message, with `executed: true` added so the caller knows the action
 * ran. Details, causes and stacks are dropped, and `E_APPROVAL_REQUIRED` is
 * never passed through. Anything else becomes a generic `E_INTERNAL`.
 */
export function actionFailure(error: unknown): ChallengeError {
  if (typeof error === "object" && error !== null) {
    const o = error as Record<string, unknown>;
    const candidate = { code: o["code"], message: o["message"], retryable: o["retryable"], correlationId: "action" };
    const parsed = errorSchema.safeParse(candidate);
    if (parsed.success && parsed.data.code !== "E_APPROVAL_REQUIRED" && error instanceof Error) {
      return new ChallengeError(parsed.data.code, parsed.data.message, { executed: true });
    }
  }
  return new ChallengeError("E_INTERNAL", GENERIC, { executed: true });
}
