// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { z } from "zod";
import { computeDigest } from "./digest.js";
import { invalid } from "./errors.js";
import type { Snapshot } from "./types.js";

const str = (max: number) => z.string().max(max);
const nullable = <T extends z.ZodType>(t: T) => t.nullable();

const Entry = z
  .object({
    id: str(4096),
    group: z.enum(["config", "hooks", "in-tree-hooks", "attributes", "link"]),
    path: str(8192),
    state: z.enum(["file", "dir", "symlink", "missing", "other", "unreadable", "oversize", "unstable"]),
    mode: nullable(z.number().int().min(0).max(0o7777)),
    size: nullable(z.number().int().min(0)),
    sha256: nullable(z.string().regex(/^[0-9a-f]{64}$/)),
    linkTarget: nullable(str(8192)),
    text: nullable(str(64 * 1024)),
    textTruncated: z.boolean(),
    binary: z.boolean(),
    detail: nullable(str(256)),
  })
  .strict();

const Setting = z
  .object({
    key: str(4096),
    value: nullable(str(4096)),
    origin: str(4096),
    line: z.number().int().min(0),
    label: str(256),
    severity: z.enum(["high", "medium"]),
    note: nullable(z.enum(["in-worktree", "outside-worktree", "unresolved"])),
  })
  .strict();

const SnapshotSchema = z
  .object({
    version: z.literal(1),
    takenAtMs: z.number().int().min(0),
    worktreePath: str(4096),
    commonDir: str(4096),
    entries: z.array(Entry).max(16_384),
    settings: z.array(Setting).max(16_384),
    refs: z.array(z.tuple([str(4096), str(512)])).max(16_384),
    incomplete: z.array(z.object({ id: str(4096), reason: str(512), blocking: z.boolean() }).strict()).max(16_384),
    link: z
      .object({ declared: nullable(str(4096)), expected: nullable(str(4096)), mismatch: z.boolean() })
      .strict(),
    digest: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

/**
 * Validates a snapshot read back from storage. A stored digest that does not match the entries is refused, so an
 * edited baseline cannot pass for the state it claims to be. Throws `E_INVALID_ARGUMENT` with fixed text.
 */
export function parseSnapshot(raw: unknown): Snapshot {
  const r = SnapshotSchema.safeParse(raw);
  if (!r.success) throw invalid("not a valid snapshot");
  const s = r.data as unknown as Snapshot;
  if (computeDigest(s.entries, s.link, s.incomplete) !== s.digest) throw invalid("snapshot digest does not match its entries");
  return s;
}
