// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { BackendId, BackendInfo, EntryMeta, Protection, SecretBackend } from "./types.js";

export interface MemoryBackendOptions {
  /** What the backend reports. Default `memory` / `ephemeral`. Tests set others to exercise PRV-1. */
  readonly id?: BackendId;
  readonly protection?: Protection;
  readonly label?: string;
}

export interface MemoryBackend extends SecretBackend {
  /** Change what the backend reports, as a platform keyring starting or stopping would. */
  setInfo(info: Partial<BackendInfo>): void;
  /** Make every call after this fail, with an error text that echoes the secret, to test containment. */
  failWith(message: string | undefined): void;
}

/**
 * A test backend that keeps secrets in memory only. Production wiring must
 * not select it: it never persists, and the real backends are a separate seam.
 */
export function createMemoryBackend(options: MemoryBackendOptions = {}): MemoryBackend {
  let info: BackendInfo = {
    id: options.id ?? "memory",
    protection: options.protection ?? "ephemeral",
    label: options.label ?? "In-memory (test)",
  };
  let failure: string | undefined;
  const entries = new Map<string, { secret: string; meta: EntryMeta }>();

  const check = (): void => {
    if (failure !== undefined) throw new Error(failure);
  };

  return {
    setInfo(next) {
      info = { ...info, ...next };
    },
    failWith(message) {
      failure = message;
    },
    async info() {
      check();
      return info;
    },
    async put(name, secret, meta) {
      check();
      entries.set(name, { secret, meta });
    },
    async get(name) {
      check();
      const e = entries.get(name);
      return e === undefined ? undefined : { secret: e.secret, meta: e.meta };
    },
    async meta(name) {
      check();
      return entries.get(name)?.meta;
    },
    async remove(name) {
      check();
      return entries.delete(name);
    },
    async list() {
      check();
      return [...entries].map(([name, e]) => ({ name, meta: e.meta }));
    },
  };
}
