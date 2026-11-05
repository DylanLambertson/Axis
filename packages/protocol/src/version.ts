// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { z } from "zod";

/** Envelope protocol versions this build can speak, ascending. */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly number[] = [1];
export const PROTOCOL_VERSION = 1;

export const protocolVersionSchema = z.number().int().min(1).max(1_000);

/** Contract id such as `axis.worktrees`, and its major version. */
export const contractIdSchema = z.string().regex(/^axis\.[a-z][a-z0-9-]{0,31}$/);
export const contractVersionSchema = z.number().int().min(1).max(1_000);

export type Negotiated =
  | { ok: true; version: number }
  | { ok: false };

/**
 * Pick the highest version both sides support. Returns `{ ok: false }` when
 * there is none; the caller answers E_VERSION_UNSUPPORTED.
 */
export function negotiateVersion(
  offered: readonly number[],
  supported: readonly number[] = SUPPORTED_PROTOCOL_VERSIONS,
): Negotiated {
  let best = -1;
  for (const v of offered) {
    if (supported.includes(v) && v > best) best = v;
  }
  return best < 0 ? { ok: false } : { ok: true, version: best };
}

/**
 * The zod this package was loaded with. A staged copy vendors zod, so the
 * daemon reports it to show which copy a bundle contains (ADR 0005 D4).
 */
export const ZOD_VERSION = `${z.core.version.major}.${z.core.version.minor}.${z.core.version.patch}`;
