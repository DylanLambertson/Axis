// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Subpath `@axis/journal/daemon-principal`. Only the daemon's connection layer may import this
// (enforced by test/packages/imports.test.mjs); it is not part of the package root.
import { mintUserPrincipal, type UserPrincipal } from "./principal.js";

export type { UserPrincipal };

/**
 * Mint the user principal. Call it only where the daemon has established, from the attested
 * connection (a ConnectionContext the renderer cannot influence), that the person is acting.
 * Never derive it from a request payload.
 */
export function userPrincipal(): UserPrincipal {
  return mintUserPrincipal();
}
