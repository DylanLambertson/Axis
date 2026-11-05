// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import {
  VaultError,
  createConsentAuthority,
  createMemoryBackend,
  createVault,
  type AccessEvent,
  type BackendId,
  type ChangeEvent,
  type Protection,
} from "../../src/index.js";

// Low-entropy stand-ins for API credentials.
export const SECRET = "vault-test-credential-0001";
export const OTHER = "vault-test-credential-0002";

export interface SetupOptions {
  rollbackTimeoutMs?: number;
  weakPolicy?: "consent" | "refuse";
  events?: AccessEvent[];
  changes?: ChangeEvent[];
  clock?: { t: number };
}

export function setup(id: BackendId, protection: Protection, extra: SetupOptions = {}) {
  const backend = createMemoryBackend({ id, protection });
  const clock = extra.clock ?? { t: 1_700_000_000_000 };
  const authority = createConsentAuthority({ now: () => clock.t });
  const events = extra.events;
  const changes = extra.changes;
  const vault = createVault({
    backend,
    consent: authority.verifier,
    ...(extra.weakPolicy === undefined ? {} : { weakPolicy: extra.weakPolicy }),
    ...(extra.rollbackTimeoutMs === undefined ? {} : { rollbackTimeoutMs: extra.rollbackTimeoutMs }),
    ...(events === undefined ? {} : { onAccess: (e: AccessEvent) => void events.push(e) }),
    ...(changes === undefined ? {} : { onChange: (e: ChangeEvent) => void changes.push(e) }),
    now: () => clock.t,
  });
  const consentFor = (connectionId: string, backendId: BackendId) => authority.grantor.grant({ connectionId, backend: backendId });
  return { backend, vault, authority, consentFor, clock };
}

export async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof VaultError, "only VaultError escapes");
    return e.code;
  }
  assert.fail("expected a failure");
}
