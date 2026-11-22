// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { z } from "zod";
import { PUSH_ENV_NAMES, PUSH_REFSPEC, PUSH_REMOTE } from "./push-run.js";

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
  execStdinChars: 1024 * 1024,
  execOutputBytes: 16 * 1024 * 1024,
  execTimeoutMs: 600_000,
  messageChars: 1024 * 1024,
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
    /** PV-M6 (ADR 0007 amendment item 1): open this run's messaging endpoint and add its two names to the child's environment. */
    messagesEndpoint: z.object({ endpoint: z.string().regex(/^ep_[A-Za-z0-9_-]{22,64}$/), token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict().optional(),
  })
  .strict();
const term = z.object({ term: id });
const absPath = z.string().min(1).max(LIMITS.pathChars);
const envRecord = z.record(z.string().min(1).max(LIMITS.envNameChars), z.string().max(LIMITS.envValueChars)).refine((e) => Object.keys(e).length <= LIMITS.envEntries);
/** A scratch attempt id: the service derives every scratch path from it and its own root, so it can name nothing else. */
export const ATTEMPT_ID = /^[a-z0-9_-]{8,64}$/;
const attempt = z.string().regex(ATTEMPT_ID);
const oid = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
/** The scratch binding: which registered attempt, and its git directory (equal to the one `scratch-begin` registered). */
const bind = z.object({ attempt, gitDir: absPath, index: z.union([z.literal(1), z.literal(2)]) }).strict();

/** A bounded, non-interactive git command (PTY-EXEC-1). Exactly one of `repo` (plain) and `bind` (scratch) is present. */
const exec = z
  .object({
    t: z.literal("exec"),
    req: id,
    argv: z.array(z.string().min(1).max(LIMITS.argvEntryBytes)).min(2).max(LIMITS.argvEntries),
    cwd: absPath,
    env: envRecord,
    stdin: z.string().max(LIMITS.execStdinChars).optional(),
    timeoutMs: z.number().int().min(1).max(LIMITS.execTimeoutMs),
    maxOutput: z.number().int().min(1).max(LIMITS.execOutputBytes),
    repo: z.object({ gitDir: absPath, workTree: absPath }).strict().optional(),
    bind: bind.optional(),
  })
  .strict();
/** A repository hook run in a user-visible terminal, answered like `spawn`. */
const hook = z
  .object({
    t: z.literal("hook"),
    req: id,
    runId: id,
    attempt,
    bind,
    hook: z.enum(["pre-commit", "commit-msg"]),
    hookPath: absPath,
    expectSha256: z.string().regex(/^[0-9a-f]{64}$/),
    message: z.string().max(LIMITS.messageChars).optional(),
    env: envRecord,
    cols: dim,
    rows: dim,
  })
  .strict();

/**
 * H9-hooks S4: `git push` of the one pinned refspec as a terminal-bound run (design §5.2), answered like `spawn`. The service
 * builds the argv, the pins and the environment; the message names the repository, a configured remote and the refspec only.
 */
const push = z
  .object({
    t: z.literal("push"),
    req: id,
    runId: id,
    repo: z.object({ gitDir: absPath, workTree: absPath }).strict(),
    remote: z.string().regex(PUSH_REMOTE),
    refspec: z.string().regex(PUSH_REFSPEC),
    /** git-ops' digest of the push URLs it read; the service's own read must match. */
    pushUrls: z.string().regex(/^[0-9a-f]{64}$/),
    env: envRecord,
    /** The configuration and ssh variables the host validated; the service's own must be the same (`PUSH_ENV_NAMES`). */
    expectEnv: z.object(Object.fromEntries(PUSH_ENV_NAMES.map((n) => [n, z.string().max(LIMITS.envValueChars).nullable()])) as Record<(typeof PUSH_ENV_NAMES)[number], z.ZodNullable<z.ZodString>>).strict(),
    cols: dim,
    rows: dim,
  })
  .strict();

/** Daemon to pty process, on the control channel: the only channel that can spawn or signal. */
export const controlRequest = z.discriminatedUnion("t", [
  spawn,
  z.object({ t: z.literal("kill"), signal }).merge(term).strict(),
  z.object({ t: z.literal("resize"), cols: dim, rows: dim }).merge(term).strict(),
  z.object({ t: z.literal("write"), data: z.string().max(LIMITS.writeChars) }).merge(term).strict(),
  /** G-2: binds an issued terminal id to one brokered data connection. Only this message lets a data connection attach. */
  z.object({ t: z.literal("grant"), conn: id }).merge(term).strict(),
  exec,
  hook,
  push,
  z.object({ t: z.literal("scratch-begin"), req: id, attempt, gitDir: absPath, worktree: absPath, tree: oid }).strict(),
  z.object({ t: z.literal("scratch-verify"), req: id, attempt }).strict(),
  z.object({ t: z.literal("scratch-end"), req: id, attempt }).strict(),
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
  z.object({ t: z.literal("spawn-failed"), req: id, code: z.enum(["env_denied", "bad_group", "capacity", "spawn_failed", "no_control", "bad_bind", "hook_changed", "bad_argv", "remote_refused", "endpoint_unavailable"]) }).strict(),
  z.object({ t: z.literal("exit"), term: id, exitCode: z.number().int().nullable(), signal: z.string().max(32).nullable() }).strict(),
  z.object({ t: z.literal("group-empty"), term: id }).strict(),
  /** Input for this terminal was dropped because the child holds too much unread input (PTY-4). Status only. */
  z.object({ t: z.literal("input-refused"), term: id }).strict(),
]);
export type ControlReply = z.infer<typeof controlReply>;

/**
 * Pty process to daemon for `exec` and `scratch-*` (a separate union so the spawn client's handling is unchanged). Exec output
 * is git plumbing output; hook output never comes here (H-7).
 */
export const execReply = z.discriminatedUnion("t", [
  z
    .object({ t: z.literal("exec-result"), req: id, code: z.number().int().nullable(), signal: z.string().max(32).nullable(), stdout: z.string(), stderr: z.string(), truncated: z.boolean() })
    .strict(),
  z.object({ t: z.literal("exec-failed"), req: id, code: z.enum(["env_denied", "bad_argv", "bad_bind", "capacity", "timeout", "spawn_failed", "no_control"]) }).strict(),
  z.object({ t: z.literal("scratch-ready"), req: id }).strict(),
  z.object({ t: z.literal("scratch-verified"), req: id, staged: z.string().max(64), files: z.enum(["same", "changed"]), message: z.enum(["same", "changed"]) }).strict(),
  z.object({ t: z.literal("scratch-ended"), req: id }).strict(),
  z.object({ t: z.literal("scratch-failed"), req: id, code: z.enum(["bad_bind", "bad_tree", "capacity", "timeout", "spawn_failed"]) }).strict(),
]);
export type ExecReply = z.infer<typeof execReply>;

/**
 * The CLI messaging endpoint relay (PV-M6, ADR 0007 decision 7.1). The pty process hosts the endpoint's listener, applies the
 * transport bounds and relays each complete frame here as its JSON text, unread; the daemon owns everything else: the token,
 * the caller (from the endpoint's binding, never from a frame), the message service and the escaping of every answer. Ids:
 * the endpoint id is the one the daemon minted for the run; the connection id is the pty process's name for one accepted
 * connection.
 */
export const ENDPOINT_ID = /^ep_[A-Za-z0-9_-]{22,64}$/;
export const RELAY_CONN_ID = /^[a-z0-9_-]{1,64}$/;
/** A request frame's JSON text: at most 64 KiB (UTF-16 units; the pty process bounds the bytes it reads first). */
export const RELAY_FRAME_CHARS = 64 * 1024;
/** A reply frame's JSON text: a read reply at the contract's caps, escaped, plus its envelope. */
export const RELAY_REPLY_CHARS = 1024 * 1024;
const endpointId = z.string().regex(ENDPOINT_ID);
const relayConn = z.string().regex(RELAY_CONN_ID);

/** Pty process to daemon: a connection opened (after the transport and peer checks), a complete frame, a connection closed. */
export const relayInbound = z.discriminatedUnion("t", [
  z.object({ t: z.literal("relay-open"), endpoint: endpointId, conn: relayConn }).strict(),
  z.object({ t: z.literal("relay-frame"), endpoint: endpointId, conn: relayConn, frame: z.string().max(RELAY_FRAME_CHARS) }).strict(),
  z.object({ t: z.literal("relay-close"), endpoint: endpointId, conn: relayConn }).strict(),
]);
export type RelayInbound = z.infer<typeof relayInbound>;

/**
 * Daemon to pty process: the reply frame for one connection (`close`: close it after sending; `authFailed`: a token failure,
 * for the pty process's per-peer backoff), or the endpoint closed with every connection (revoked or paused).
 */
export const relayOutbound = z.discriminatedUnion("t", [
  z.object({ t: z.literal("relay-reply"), endpoint: endpointId, conn: relayConn, frame: z.string().max(RELAY_REPLY_CHARS), close: z.boolean(), authFailed: z.boolean() }).strict(),
  z.object({ t: z.literal("endpoint-close"), endpoint: endpointId, reason: z.enum(["revoked", "paused"]) }).strict(),
]);
export type RelayOutbound = z.infer<typeof relayOutbound>;

/** What the pty process may say on a data channel (not validated by the daemon; the renderer owns that end). */
export type DataReply =
  | { readonly t: "attached"; readonly term: string }
  | { readonly t: "refused"; readonly term: string | null; readonly code: "foreign_terminal" | "unsupported" | "invalid" | "input_full" }
  | { readonly t: "data"; readonly term: string; readonly chunk: string }
  | { readonly t: "overflow"; readonly term: string; readonly chars: number }
  | { readonly t: "exit"; readonly term: string };
