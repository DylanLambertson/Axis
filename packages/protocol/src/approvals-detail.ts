// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { z } from "zod";
import { challengeIdSchema } from "./challenge.js";
import { composerModelIdSchema, composerModeSchema, composerProviderIdSchema, REFUSED_ACTIVITY } from "./composer-runs.js";
import { displayTextSchema, guarded } from "./guard.js";
import { pluginIdSchema } from "./messages-wire.js";

/**
 * A challenge a plugin caused (PV-K1e-a2, `docs/design/plugin-run-start.md`): who asked, on a listed challenge, and the full
 * request the user approves, read by `axis.approvals/1.detail`. The daemon builds both; nothing here comes from the plugin
 * but the prompt, which the daemon escapes (reversibly: control and invisible characters as `\u{hex}`, a backslash doubled).
 */

/** Open plugin challenges one window holds at once (the gate's bound), so at most this many listed challenges name a requester. */
export const MAX_PLUGIN_CHALLENGES_PER_WINDOW = 4;
/** Longest escaped prompt a detail carries, in UTF-16 units: a prompt whose escaped form is longer is refused at issue, never cut. */
export const MAX_DETAIL_PROMPT = 65_536;

/** The closed requester of a listed challenge: present only on a challenge a plugin caused. */
export const challengeRequesterSchema = z.strictObject({ kind: z.literal("plugin"), pluginId: pluginIdSchema.max(64) });
export type ChallengeRequester = z.infer<typeof challengeRequesterSchema>;

const escapedTextSchema = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((t) => !REFUSED_ACTIVITY.test(t), { message: "no control or invisible characters" });

/** What the user approves for a plugin's run start: every field the start uses, the prompt whole. */
export const runStartDetailSchema = z.strictObject({
  kind: z.literal("runs.start"),
  requester: challengeRequesterSchema,
  prompt: escapedTextSchema(MAX_DETAIL_PROMPT),
  /** The project's and workspace's display names, which the user chose. */
  project: displayTextSchema(128),
  workspace: displayTextSchema(128),
  mode: composerModeSchema,
  provider: composerProviderIdSchema,
  model: composerModelIdSchema,
});
export const challengeDetailSchema = z.discriminatedUnion("kind", [runStartDetailSchema]);
export type ChallengeDetail = z.infer<typeof challengeDetailSchema>;

// detail (read, tier 0, user only): one challenge of the caller's own window, while it is still pending and its binding holds
export const approvalsDetailRequestSchema = guarded(z.strictObject({ challengeId: challengeIdSchema }));
export const approvalsDetailResponseSchema = guarded(z.strictObject({ challengeId: challengeIdSchema, detail: challengeDetailSchema }));
