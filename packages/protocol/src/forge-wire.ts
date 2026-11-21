// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { z } from "zod";

/**
 * The pty process's `forge-list` message and its replies (docs/design/forge-pr-list.md §1, §7): the ONE definition both
 * sides use. The daemon's forge binding sends `forgeListRequestSchema` and parses `forgeReplySchema`; the pty process (ticket
 * PV-D2 slice S1b) parses the request and builds the reply with the same schemas. No argv, env, cwd or flag travels: the pty
 * process composes the command from a closed template, and the stderr text never leaves it (only a closed class does).
 */

/** v1 talks to this host only (§3). */
export const FORGE_HOST = "github.com" as const;

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * The one owner and repository check (review 1 N2): the GitHub owner pattern, the repository pattern, and never `.` or
 * `..` (a daemon-built link `https://github.com/o/../pull/5` would normalise elsewhere). `git-ops` `compareUrl` uses it
 * for remotes, the forge binding for the pin, the pty process before composing the command.
 */
export function vetOwnerRepo(owner: unknown, repo: unknown): boolean {
  return typeof owner === "string" && typeof repo === "string" && OWNER.test(owner) && REPO.test(repo) && repo !== "." && repo !== "..";
}

const reqId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

export const forgeListRequestSchema = z
  .strictObject({ t: z.literal("forge-list"), req: reqId, host: z.literal(FORGE_HOST), owner: z.string().max(39), repo: z.string().max(100) })
  .refine((m) => vetOwnerRepo(m.owner, m.repo), "owner or repository refused");
export type ForgeListRequest = z.infer<typeof forgeListRequestSchema>;

/** What the pty process makes of `gh`'s stderr (§7): a closed value; the text itself is discarded there. */
export const FORGE_STDERR_CLASSES = ["none", "auth_missing", "keyring", "repo_missing", "network", "other"] as const;
export type ForgeStderrClass = (typeof FORGE_STDERR_CLASSES)[number];

/** Why no `gh` output exists (§1, §7; the `ExecStartError` codes of PV-X1a map onto these). */
export const FORGE_FAILURE_CODES = ["spawn_missing", "spawn_failed", "too_old", "version_unknown", "timeout", "capacity", "bad_request", "no_control", "unsupported_platform"] as const;
export type ForgeFailureCode = (typeof FORGE_FAILURE_CODES)[number];

/** The stdout cap of a `forge-list` call (§1); the reply carries at most this many characters of it. */
export const FORGE_MAX_STDOUT = 4 * 1024 * 1024;

export const forgeReplySchema = z.discriminatedUnion("t", [
  z.strictObject({
    t: z.literal("forge-result"),
    req: reqId,
    exit: z.number().int().min(0).max(255).nullable(),
    class: z.enum(FORGE_STDERR_CLASSES),
    stdout: z.string().max(FORGE_MAX_STDOUT),
    /** stdout reached its cap (the exec outcome's `stdoutTruncated`); stderr truncation is not reported. */
    truncated: z.boolean(),
  }),
  z.strictObject({ t: z.literal("forge-failed"), req: reqId, code: z.enum(FORGE_FAILURE_CODES) }),
]);
export type ForgeReply = z.infer<typeof forgeReplySchema>;
