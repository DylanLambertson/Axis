// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
export { AxisError, ERROR_CODES, type ErrorCode } from "./errors.js";
export { canonicalize, type JsonValue } from "./canonical.js";
export {
  Redactor,
  placeholder,
  summarizeContent,
  MIN_REGISTERED_SECRET_LENGTH,
  MAX_STRING_CHARS,
  REDACTION_RULES,
  isWellFormedString,
  wellFormed,
  type RedactionKind,
  type RedactionRule,
} from "./redact.js";
export {
  assertPrivateFiles,
  assertSafeDirectory,
  mapSqlite,
  mapSqliteError,
  openDatabase,
  runMigrations,
  schemaVersion,
  withTransaction,
  type DatabaseSync,
  type DirectoryFs,
  type Migration,
  type OpenOptions,
} from "./db.js";
export { DEFAULT_PAYLOAD_ALLOWLIST, MAX_PAYLOAD_CHARS } from "./payload-policy.js";
export {
  AuditLog,
  AuditActions,
  AUDIT_OUTCOMES,
  AUDIT_SCHEMA_VERSION,
  GENESIS_HASH,
  HASH_VERSION,
  type AuditActor,
  type AuditEvent,
  type AuditEventInput,
  type AuditLogOptions,
  type AuditOutcome,
  type AuditSink,
  type ChainHead,
  type VerifyFailureReason,
  type VerifyOptions,
  type VerifyResult,
} from "./log.js";
export { acquireInstanceLock, processStartTime, InstanceLock, type LockOptions } from "./lock.js";
