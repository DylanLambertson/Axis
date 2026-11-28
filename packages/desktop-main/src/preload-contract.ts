// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { projectIdSchema } from "@axis/protocol";

/**
 * The fixed preload contract (ADR 0011 Decision 2, "One preload, fixed and small"). The preload (`apps/desktop/preload`, second PR)
 * exposes exactly one frozen global, `PRELOAD_GLOBAL`, with exactly the functions in `PRELOAD_FUNCTIONS`, and each sends one fixed
 * channel of `IPC_CHANNELS`. There is no generic `ipcRenderer`, no channel argument and no `send`; ADR 0003 D7's "no new
 * `contextBridge` globals" becomes "exactly this one", pinned by a source test of the preload.
 *
 * Main parses every payload here before anything else looks at it (after the sender checks of window-registry.ts). A payload is
 * accepted only as a plain object (or, for `connect`, a string) with exactly the listed keys. A path never crosses this boundary:
 * main takes folders from its own picker.
 */

export const PRELOAD_GLOBAL = "axis";
export const PRELOAD_FUNCTIONS = Object.freeze(["connect", "projectAction", "terminalPort", "openExternal"] as const);
export type PreloadFunction = (typeof PRELOAD_FUNCTIONS)[number];

/** Renderer to main. Each function sends only its own channel. */
export const IPC_CHANNELS: Readonly<Record<PreloadFunction, string>> = Object.freeze({
  connect: "axis:connect",
  projectAction: "axis:projectAction",
  terminalPort: "axis:terminalPort",
  openExternal: "axis:openExternal",
});

/** Main to renderer. `openExternal` is answered as the `invoke` result. */
export const IPC_REPLY_CHANNELS = Object.freeze({
  connect: "axis:connectResult",
  projectAction: "axis:projectActionResult",
  terminalPort: "axis:terminalPortResult",
} as const);

/** The connect nonce, as `connect-broker.ts` checks it. */
export const CONNECT_NONCE = /^[A-Za-z0-9-]{1,64}$/;
/** The nonce of the other requests, as `project-actions.ts` checks it. */
export const REQUEST_NONCE = /^[A-Za-z0-9_-]{1,64}$/;
/** A pty terminal id (DC-3a defines it in `axis.terminals/1`; until then, a journal-id shape). */
export const TERMINAL_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** The project actions. `open` (bind the window to a registered project the daemon confirms, OS-3b) is the only one that names a project. */
export const PRELOAD_PROJECT_ACTIONS = Object.freeze(["add", "trust", "untrust", "status", "open"] as const);
export type PreloadProjectAction = (typeof PRELOAD_PROJECT_ACTIONS)[number];

/** True for a plain object whose own enumerable string keys are exactly `required` plus any of `optional`, all data properties. */
function exactObject(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  if (Object.getOwnPropertySymbols(value).length !== 0) return false;
  const keys = Object.getOwnPropertyNames(value);
  for (const k of keys) {
    if (!required.includes(k) && !optional.includes(k)) return false;
    const d = Object.getOwnPropertyDescriptor(value, k);
    if (d === undefined || !("value" in d) || d.enumerable !== true) return false;
  }
  return required.every((k) => keys.includes(k));
}

const str = (v: unknown, re: RegExp): v is string => typeof v === "string" && re.test(v);

export function parseConnect(payload: unknown): string | undefined {
  return str(payload, CONNECT_NONCE) ? payload : undefined;
}

export type ProjectActionRequest = { readonly nonce: string; readonly action: Exclude<PreloadProjectAction, "open"> } | { readonly nonce: string; readonly action: "open"; readonly projectId: string };

export function parseProjectAction(payload: unknown): ProjectActionRequest | undefined {
  if (!exactObject(payload, ["nonce", "action"], ["projectId"])) return undefined;
  const { nonce, action } = payload;
  if (!str(nonce, REQUEST_NONCE) || typeof action !== "string" || !(PRELOAD_PROJECT_ACTIONS as readonly string[]).includes(action)) return undefined;
  const has = Object.hasOwn(payload, "projectId");
  if (action === "open") {
    if (!has || !projectIdSchema.safeParse(payload["projectId"]).success) return undefined;
    return Object.freeze({ nonce, action, projectId: payload["projectId"] as string });
  }
  if (has) return undefined;
  return Object.freeze({ nonce, action: action as Exclude<PreloadProjectAction, "open"> });
}

export function parseTerminalPort(payload: unknown): { readonly nonce: string; readonly terminalId: string } | undefined {
  if (!exactObject(payload, ["nonce", "terminalId"])) return undefined;
  const { nonce, terminalId } = payload;
  return str(nonce, REQUEST_NONCE) && str(terminalId, TERMINAL_ID) ? Object.freeze({ nonce, terminalId }) : undefined;
}

/** `openExternal`'s payload is `{ url }`; the URL itself is judged by `decideExternal`. */
export function parseOpenExternal(payload: unknown): unknown {
  return exactObject(payload, ["url"]) ? payload["url"] : undefined;
}
