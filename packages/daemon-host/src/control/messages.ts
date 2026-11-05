// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { isAbsolute } from "node:path";
import { z } from "zod";
import {
  boundedJsonSchema,
  chainHeadSchema,
  challengeIdSchema,
  contractIdSchema,
  displayTextSchema,
  errorCodeSchema,
  protocolVersionSchema,
  reasonCodeSchema,
} from "@axis/protocol";

/**
 * The control plane (design section 6.3): every message between the supervisor and the host is one of these strict
 * schemas, and everything on the channel is supervisor-authenticated by construction. A client's byte stream is
 * never parsed as a control message. `type` selects the schema; an unknown `type` or key refuses the message.
 * Requests that expect an answer carry a `requestId` and the answer carries the same one.
 */

/** Largest control message the host reads (the mux checks it before any schema runs). */
export const MAX_CONTROL_BYTES = 262_144;

export const requestIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const scopeIdSchema = z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/);
/** The id of one virtual connection on a multiplexed channel. */
export const cidSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
/** The native-confirmation secret (`takeNativeProof`) as the supervisor sees it. */
const proofSchema = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/);
const MAX_PATH_CHARS = 4096;

/** The settings the host may ask main for (design 6.3, `settings.get`). */
export const SETTING_KEYS = ["axis.cliAgents", "axis.git.runHooks"] as const;
export const settingKeySchema = z.enum(SETTING_KEYS);
export type SettingKey = z.infer<typeof settingKeySchema>;

/**
 * What the supervisor attaches to a connection: the identity it vouches for, when, and the MAC over both
 * (`attestation.ts`). The identity is checked by the verifier with the daemon's `identitySchema`, not here.
 */
export const attestationSchema = z.strictObject({
  identity: z.record(z.string().max(64), boundedJsonSchema),
  issuedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  mac: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
export type Attestation = z.infer<typeof attestationSchema>;

export const initMessageSchema = z.strictObject({
  type: z.literal("init"),
  /** Parsed by `parseHostConfig`, which owns the schema and registers the key with the redactor. */
  config: z.record(z.string().max(64), z.unknown()),
});

export const connectMessageSchema = z.strictObject({
  type: z.literal("connect"),
  /** Present on a multiplexed channel; absent when a port is transferred with the message (Electron). */
  cid: cidSchema.optional(),
  attestation: attestationSchema,
});

export const anchorResultSchema = z.strictObject({
  type: z.literal("anchor.result"),
  requestId: requestIdSchema,
  anchor: chainHeadSchema.nullable(),
});

export const anchorAckSchema = z.strictObject({ type: z.literal("anchor.ack"), seq: z.number().int().min(1) });

export const nativeResultSchema = z.strictObject({
  type: z.literal("native.result"),
  challengeId: challengeIdSchema,
  proof: proofSchema,
  confirmed: z.boolean(),
  windowId: scopeIdSchema,
});

export const trustResultSchema = z.strictObject({
  type: z.literal("trust.result"),
  requestId: requestIdSchema,
  trusted: z.boolean(),
});

export const trustSetSchema = z.strictObject({
  type: z.literal("trust.set"),
  windowId: scopeIdSchema,
  workspaceId: scopeIdSchema.optional(),
  trusted: z.boolean(),
});

export const settingsResultSchema = z.strictObject({
  type: z.literal("settings.result"),
  requestId: requestIdSchema,
  key: settingKeySchema,
  /** `null` when the user has not set it. Validated by the caller with the owning package's schema. */
  value: boundedJsonSchema,
});

export const projectsRegisterSchema = z.strictObject({
  type: z.literal("projects.register"),
  requestId: requestIdSchema,
  path: z
    .string()
    .min(1)
    .max(MAX_PATH_CHARS)
    .refine((p) => !p.includes("\0") && isAbsolute(p), "absolute path required"),
  trusted: z.boolean(),
});

export const shutdownSchema = z.strictObject({ type: z.literal("shutdown") });

/** Supervisor to host. */
export const inboundMessageSchema = z.discriminatedUnion("type", [
  initMessageSchema,
  connectMessageSchema,
  anchorResultSchema,
  anchorAckSchema,
  nativeResultSchema,
  trustResultSchema,
  trustSetSchema,
  settingsResultSchema,
  projectsRegisterSchema,
  shutdownSchema,
]);
export type InboundMessage = z.infer<typeof inboundMessageSchema>;

const readySchema = z.strictObject({
  type: z.literal("ready"),
  protocolVersion: protocolVersionSchema,
  contracts: z.array(contractIdSchema).max(32),
  /** A reason code, never text: main shows the integrity failure from it. */
  degraded: reasonCodeSchema.optional(),
});

const anchorGetSchema = z.strictObject({ type: z.literal("anchor.get"), requestId: requestIdSchema });
const anchorPutSchema = z.strictObject({ type: z.literal("anchor.put"), ...chainHeadSchema.shape });

const nativeConfirmSchema = z.strictObject({
  type: z.literal("native.confirm"),
  challengeId: challengeIdSchema,
  proof: proofSchema,
  windowId: scopeIdSchema,
  summary: displayTextSchema(192),
});

const trustCheckSchema = z.strictObject({
  type: z.literal("trust.check"),
  requestId: requestIdSchema,
  windowId: scopeIdSchema,
  workspaceId: scopeIdSchema,
  projectId: scopeIdSchema,
});

const settingsGetSchema = z.strictObject({
  type: z.literal("settings.get"),
  requestId: requestIdSchema,
  key: settingKeySchema,
});

const projectsResultSchema = z.union([
  z.strictObject({ type: z.literal("projects.result"), requestId: requestIdSchema, ok: z.literal(true), projectId: scopeIdSchema }),
  z.strictObject({
    type: z.literal("projects.result"),
    requestId: requestIdSchema,
    ok: z.literal(false),
    code: errorCodeSchema,
    reason: reasonCodeSchema.optional(),
  }),
]);

const fatalSchema = z.strictObject({ type: z.literal("fatal"), code: errorCodeSchema, reason: reasonCodeSchema.optional() });

const logSchema = z.strictObject({
  type: z.literal("log"),
  level: z.enum(["debug", "info", "warn", "error"]),
  event: z.string().regex(/^[a-z][a-z0-9._]{0,63}$/),
  fields: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,31}$/), z.union([z.string().max(128), z.number(), z.boolean()])).optional(),
});

/** Host to supervisor. Every outbound message is parsed with this before it is sent. */
export const outboundMessageSchema = z.union([
  readySchema,
  anchorGetSchema,
  anchorPutSchema,
  nativeConfirmSchema,
  trustCheckSchema,
  settingsGetSchema,
  projectsResultSchema,
  fatalSchema,
  logSchema,
]);
export type OutboundMessage = z.infer<typeof outboundMessageSchema>;
