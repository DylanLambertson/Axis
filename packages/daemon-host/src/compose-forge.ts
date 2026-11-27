// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// `axis.forge/1` in the composition (ticket PV-D2 slice 2, docs/design/forge-pr-list.md §9): the forge service over the pty
// process's `forge-list`, the project's main checkout and the journal's pin store (schema v13), registered through the host's registrar. Kept
// out of compose.ts (its line budget); the composition root calls `registerForgeServing` and nothing else of this file.
import { randomBytes } from "node:crypto";
import type { GitOpsDeps } from "@axis/git-ops";
import type { AuditEventInput } from "@axis/audit";
import { createOriginReader } from "./forge/origin.js";
import type { ForgeRepository } from "@axis/protocol";
import { createForgeService, type ForgeListPort, type PinStore } from "./forge/service.js";
import { registerForgeHandlers } from "./handlers/forge.js";
import type { HandlerRegistrar } from "./handlers/anchor-guard.js";
import type { Logger } from "./log/logger.js";
import type { PtyForgePort } from "./ports/pty.js";

/**
 * The platforms where `gh` cannot find the keyring login with the generated configuration (§4): the daemon answers
 * `auth_unsupported` there without running `gh`. Filled from the recorded per-platform gate (the owner-run evidence slice); empty
 * until a platform fails it.
 */
export const FORGE_AUTH_UNSUPPORTED: ReadonlySet<NodeJS.Platform> = new Set();

export interface ForgeServingDeps {
  /** The host's pty port; `forgeList` absent (a test port, an older pty process): every list is `unavailable`. */
  readonly pty: Partial<PtyForgePort> | undefined;
  readonly projectPath: (projectId: string) => string | undefined;
  readonly git: GitOpsDeps;
  readonly platform: NodeJS.Platform;
  /** Appends one audit row and marks the anchor batch dirty. */
  readonly audit: (event: AuditEventInput) => void;
  readonly monotonic: () => number;
  readonly logger?: Logger;
  /** The journal's pins (`journal.forgePins`, schema v13). What it returns is only a candidate: the service re-vets it. */
  readonly pins: StoredPins;
}

/** The journal's `ForgePinRecords`, structurally (a stored host is any string until the service vets it). */
export interface StoredPins {
  get(projectId: string): { readonly host: string; readonly owner: string; readonly repo: string } | undefined;
  set(projectId: string, repository: ForgeRepository): void;
}

/** The service's pin store over the journal. A stored value that is not a vetted github.com repository is no pin (the service checks). */
export function journalPinStore(pins: StoredPins): PinStore {
  return {
    get: (projectId) => pins.get(projectId) as ForgeRepository | undefined,
    set: (projectId, repository) => pins.set(projectId, { host: repository.host, owner: repository.owner, repo: repository.repo }),
  };
}

/** The service's one line per exec (`forge: state=<state> exit=<code|none>`) as a closed log record; any other line is dropped. */
const EXEC_LINE = /^forge: state=([a-z_]{1,32}) exit=(none|[0-9]{1,3})$/;
export function forgeLogLine(logger: Logger | undefined): (line: string) => void {
  return (line) => {
    const m = EXEC_LINE.exec(line);
    if (m !== null) logger?.info("forge.list", { reason: m[1] as string, code: m[2] as string });
  };
}

/** A fresh `forge-list` request id: 128 random bits, base64url (`[A-Za-z0-9_-]`, 22 characters). */
export const forgeRequestId = (): string => randomBytes(16).toString("base64url");

export function registerForgeServing(registrar: HandlerRegistrar, deps: ForgeServingDeps): void {
  const forgeList = deps.pty?.forgeList;
  const port: ForgeListPort | undefined = typeof forgeList === "function" ? { list: (request) => forgeList.call(deps.pty, request) } : undefined;
  const service = createForgeService({
    projectExists: (projectId) => deps.projectPath(projectId) !== undefined,
    readOrigin: createOriginReader({ projectPath: deps.projectPath, git: deps.git, platform: deps.platform, uid: typeof process.getuid === "function" ? process.getuid() : undefined }),
    ...(port === undefined ? {} : { port }),
    audit: { append: (e) => deps.audit(e) },
    monotonic: deps.monotonic,
    requestId: forgeRequestId,
    authUnsupported: FORGE_AUTH_UNSUPPORTED.has(deps.platform),
    log: forgeLogLine(deps.logger),
    // Slice 2b: the pin is the journal's (schema v13), so it survives a restart; a re-pin updates it in place.
    pins: journalPinStore(deps.pins),
  });
  registerForgeHandlers(registrar, { service });
}
