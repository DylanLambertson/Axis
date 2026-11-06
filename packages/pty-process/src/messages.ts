// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { z } from "zod";

/** Bounds on every untrusted field, so a hostile peer cannot make the other end allocate without limit. */
export const LIMITS = {
  argvEntries: 256,
  argvEntryBytes: 32768,
  envEntries: 4096,
  envNameChars: 256,
  envValueChars: 32768,
  pathChars: 4096,
  dimension: 1000,
  writeChars: 65536,
  idChars: 128,
  ackChars: 16 * 1024 * 1024,
} as const;

const id = z.string().min(1).max(LIMITS.idChars);
const dim = z.number().int().min(1).max(LIMITS.dimension);
const signal = z.enum(["SIGINT", "SIGTERM", "SIGKILL"]);

const spawn = z
  .object({
    t: z.literal("spawn"),
    req: id,
    runId: id,
    argv: z.array(z.string().min(1).max(LIMITS.argvEntryBytes)).min(1).max(LIMITS.argvEntries),
    cwd: z.string().min(1).max(LIMITS.pathChars),
    env: z.record(z.string().min(1).max(LIMITS.envNameChars), z.string().max(LIMITS.envValueChars)).refine((e) => Object.keys(e).length <= LIMITS.envEntries),
    cols: dim,
    rows: dim,
  })
  .strict();
const term = z.object({ term: id });

/** Daemon to pty process, on the control channel: the only channel that can spawn or signal. */
export const controlRequest = z.discriminatedUnion("t", [
  spawn,
  z.object({ t: z.literal("kill"), signal }).merge(term).strict(),
  z.object({ t: z.literal("resize"), cols: dim, rows: dim }).merge(term).strict(),
  z.object({ t: z.literal("write"), data: z.string().max(LIMITS.writeChars) }).merge(term).strict(),
  /** G-2: binds an issued terminal id to one brokered data connection. Only this message lets a data connection attach. */
  z.object({ t: z.literal("grant"), conn: id }).merge(term).strict(),
]);
export type ControlRequest = z.infer<typeof controlRequest>;

/** Renderer (through main's brokered port) to pty process, on a data channel: attach to an issued id, then keystrokes and size. */
export const dataRequest = z.discriminatedUnion("t", [
  z.object({ t: z.literal("attach") }).merge(term).strict(),
  z.object({ t: z.literal("write"), data: z.string().max(LIMITS.writeChars) }).merge(term).strict(),
  z.object({ t: z.literal("resize"), cols: dim, rows: dim }).merge(term).strict(),
  /** Flow control: the renderer has consumed `chars` characters of output. Without acks the pty process pauses the child (see flow.ts). */
  z.object({ t: z.literal("ack"), chars: z.number().int().min(1).max(LIMITS.ackChars) }).merge(term).strict(),
]);
export type DataRequest = z.infer<typeof dataRequest>;

export const groupSchema = z.discriminatedUnion("kind", [z.object({ kind: z.literal("pgid"), pgid: z.number().int().min(2) }).strict(), z.object({ kind: z.literal("job") }).strict()]);

/** Pty process to daemon. Terminal output is never sent here: the daemon sees status only. */
export const controlReply = z.discriminatedUnion("t", [
  z.object({ t: z.literal("spawned"), req: id, term: id, group: groupSchema }).strict(),
  z.object({ t: z.literal("spawn-failed"), req: id, code: z.enum(["env_denied", "bad_group", "capacity", "spawn_failed", "no_control"]) }).strict(),
  z.object({ t: z.literal("exit"), term: id, exitCode: z.number().int().nullable(), signal: z.string().max(32).nullable() }).strict(),
  z.object({ t: z.literal("group-empty"), term: id }).strict(),
]);
export type ControlReply = z.infer<typeof controlReply>;

/** What the pty process may say on a data channel (not validated by the daemon; the renderer owns that end). */
export type DataReply =
  | { readonly t: "attached"; readonly term: string }
  | { readonly t: "refused"; readonly term: string | null; readonly code: "foreign_terminal" | "unsupported" | "invalid" | "input_full" }
  | { readonly t: "data"; readonly term: string; readonly chunk: string }
  | { readonly t: "overflow"; readonly term: string; readonly chars: number }
  | { readonly t: "exit"; readonly term: string };
