// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { Identity } from "@axis/daemon";
import { attestedIdentityForTests } from "@axis/daemon/testing";

/** Identities marked as attested, as a session holds them, for tests of the project trust gate (PV-K1c). */
export const attestedWindow = (windowId: string, over: Partial<Identity> = {}): Identity =>
  attestedIdentityForTests({ connectionId: "A".repeat(22), windowId, actorId: "local-user", actor: "user", trusted: true, clientKind: "desktop", ...over });

export const attestedPlugin = (over: Record<string, unknown> = {}): Identity =>
  attestedIdentityForTests({ connectionId: "B".repeat(22), windowId: "p7", actorId: "plugin:acme", actor: "plugin:acme", workspaceId: "p", trusted: false, clientKind: "plugin", hostWindowId: "w3", ...over });
