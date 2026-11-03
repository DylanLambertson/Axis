// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
export { Daemon, type DaemonOptions } from "./daemon.js";
export { fromElectronPort, fromNodePort, memoryPair, type ElectronPortLike } from "./transport.js";
export { protocolRegistry } from "./support.js";
export { MemoryIdempotencyStore, type MemoryStoreOptions } from "./memory-store.js";
export { canonicalJson, payloadHash, requestDigest, REQUEST_DIGEST_TAG } from "./digest.js";
export { DaemonError, SAFE_MESSAGE_MAX } from "./errors.js";
export { identitySchema } from "./identity.js";
export type { SessionLimits } from "./session.js";
export {
  ApprovalError,
  type ActorId,
  type ApprovalGate,
  type ApprovalInput,
  type ApprovalContent,
  type ApprovalContentHook,
  type ApprovalContentLock,
  type ConfirmedAction,
  type Connection,
  type ContractRegistry,
  type DaemonAuditEvent,
  type DaemonAuditSink,
  type Handler,
  type HandlerContext,
  type IdempotencyBegin,
  type IdempotencyKey,
  type IdempotencyStore,
  type Identity,
  type IdentityVerifier,
  type Policy,
  type PolicyDecision,
  type PolicyInput,
} from "./types.js";
