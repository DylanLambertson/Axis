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
  /**
   * The backend changed between `info()` and `put()`: writes would land on `info`. By default the backend
   * behaves as the `SecretBackend.put` contract requires and refuses; `write_anyway` models one that does not,
   * to test the vault's second line of defence. Undefined restores normal behaviour.
   */
  landWritesOn(info: { id: BackendId; protection: Protection } | undefined, mode?: "refuse" | "write_anyway"): void;
  /** Make every call after this fail, with an error text that echoes the secret, to test containment. */
  failWith(message: string | undefined): void;
  /** Replace what `meta()` and `list()` return for an entry, to test a backend that returns bad data. */
  corruptMeta(name: string, raw: unknown): void;
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
  let landed: { id: BackendId; protection: Protection } | undefined;
  let landedMode: "refuse" | "write_anyway" = "refuse";
  const entries = new Map<string, { secret: string; meta: unknown }>();

  const check = (): void => {
    if (failure !== undefined) throw new Error(failure);
  };

  return {
    setInfo(next) {
      info = { ...info, ...next };
    },
    landWritesOn(next, mode = "refuse") {
      landed = next;
      landedMode = mode;
    },
    failWith(message) {
      failure = message;
    },
    corruptMeta(name, raw) {
      const e = entries.get(name);
      if (e !== undefined) e.meta = raw;
    },
    async info() {
      check();
      return info;
    },
    async put(name, secret, meta) {
      check();
      if (landed !== undefined && landedMode === "refuse") throw new Error("the write would land on another backend");
      entries.set(name, { secret, meta });
      return landed ?? { id: info.id, protection: info.protection };
    },
    async get(name) {
      check();
      const e = entries.get(name);
      return e === undefined ? undefined : { secret: e.secret, meta: e.meta as EntryMeta };
    },
    async meta(name) {
      check();
      return entries.get(name)?.meta as EntryMeta | undefined;
    },
    async remove(name) {
      check();
      return entries.delete(name);
    },
    async list() {
      check();
      return [...entries].map(([name, e]) => ({ name, meta: e.meta as EntryMeta }));
    },
  };
}
