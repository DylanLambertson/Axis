// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// TEST ONLY: an in-memory secret backend for the integrations tests, built by hand because no host file but the two bindings
// may load `@axis/vault` (test/packages/vault-importers-rule.mjs), tests included. It follows the `SecretBackend` contract.
import type { SecretBackend } from "../src/bindings/integrations.js";

type Info = Awaited<ReturnType<SecretBackend["info"]>>;
type Meta = { readonly storedAt: number; readonly backend: Info["id"]; readonly protection: Info["protection"]; readonly weakConsent: boolean };

export interface TestBackend extends SecretBackend {
  /** Hold `secret` under `name` with this metadata (default: the current backend's). */
  seed(name: string, secret: string, meta?: Partial<Meta>): void;
  /** What `info()` reports from now on. */
  setInfo(next: Partial<Info>): void;
  /** Every call fails, with a text that echoes `message` (to test that no backend text crosses). */
  failWith(message: string | undefined): void;
}

export function testBackend(info: Partial<Info> = {}): TestBackend {
  let current: Info = { id: "macos_keychain", protection: "os_protected", label: "Test keyring", ...info };
  let failure: string | undefined;
  const entries = new Map<string, { secret: string; meta: Meta }>();
  const check = (): void => {
    if (failure !== undefined) throw new Error(failure);
  };
  return {
    seed: (name, secret, meta = {}) => void entries.set(name, { secret, meta: { storedAt: 1, backend: current.id, protection: current.protection, weakConsent: false, ...meta } }),
    setInfo: (next) => void (current = { ...current, ...next }),
    failWith: (message) => void (failure = message),
    info: async () => (check(), current),
    put: async (name, secret, meta) => (check(), entries.set(name, { secret, meta: meta as Meta }), { id: current.id, protection: current.protection }),
    get: async (name) => (check(), entries.get(name)),
    meta: async (name) => (check(), entries.get(name)?.meta),
    remove: async (name) => (check(), entries.delete(name)),
    list: async () => (check(), [...entries].map(([name, e]) => ({ name, meta: e.meta }))),
  };
}
