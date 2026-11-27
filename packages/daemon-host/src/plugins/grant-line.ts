// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { createHash } from "node:crypto";
import type { PluginPermission } from "@axis/journal";
import { PLUGIN_DANGEROUS_COMBINATIONS } from "../policy/plugin-rules.js";

/**
 * The native dialog line of a plugin grant or enable (PV-K2 K2-g2, `docs/design/plugin-grant-contract.md` section 3.1). Main's
 * dialog shows `<action>: <detail>`; `nativeSummary` replaces a detail with a control, format, surrogate or separator character
 * and cuts one past 80 UTF-16 units in the middle. So the detail is built here, from daemon-derived values only (never manifest
 * text), sanitised part by part and budgeted as a WHOLE before it is handed over: it is never cut and never replaced.
 *
 * Order: the danger marker (when the grant completes a dangerous combination), the permission's fixed wording, then the plugin
 * in a stable short form, then the project's display name (the repository folder's name, which its author chose, not the user;
 * like the plugin id it can only add words after the fixed wording) in what remains. The marker and the wording are
 * never dropped: a line whose fixed parts leave the project fewer than `MIN_PROJECT_UNITS` is refused (`dialog_overflow`), and
 * the content hook then refuses the request at issue. The digest binds the full ids; the short id only names them.
 */
export const DIALOG_DETAIL_UNITS = 80;
export const MIN_PROJECT_UNITS = 8;
export const DANGER_MARKER = "SENDS DATA OUT: ";
/**
 * The plugin's units on the line (review K2-g2 N2): the most the worst case leaves with the project its minimum (the danger marker,
 * the longest wording, the separators and `MIN_PROJECT_UNITS`: 16 + 28 + 2 + 22 + 4 + 8 = 80).
 */
export const ID_UNITS = 22;
/** Hex digits of the whole id's SHA-256 in the short form: 60 bits, so finding another id with the same short form is not practical. */
export const ID_HASH_HEX = 15;
const ID_PREFIX = ID_UNITS - 1 - ID_HASH_HEX;

/** The fixed wording of each grant (at most 28 units) and of an enable. */
export const GRANT_WORDING: Readonly<Record<PluginPermission, string>> = Object.freeze({
  "agents.read": "may read workers and runs",
  "messages.send": "may send messages",
  "tasks.read": "may read tasks",
  "tasks.write": "may draft tasks",
  "pages.read": "may read pages",
  "pages.write": "may write pages",
  "runs.start": "may ask to start AI runs",
  "files.read": "may read project files",
});
export const ENABLE_WORDING = "turn on, keeping its grants";

const UNSAFE = /[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/gu;

export class DialogOverflow extends Error {
  constructor() {
    super("dialog_overflow");
  }
}

/**
 * Unsafe characters become `?` (in `u` mode a lone surrogate is a `Cs` code point; a well-formed pair is not), runs of space
 * collapse, and the result is trimmed.
 */
export function sanitise(text: string): string {
  return text.replace(/\p{Z}+/gu, " ").replace(UNSAFE, "?").trim();
}

/** Cut by whole code points to at most `units` UTF-16 units, the cut ending in "…". */
function fitted(text: string, units: number): string {
  if (text.length <= units) return text;
  let out = "";
  for (const p of text) {
    if (out.length + p.length > units - 1) break;
    out += p;
  }
  return `${out}…`;
}

/**
 * The plugin id itself when it fits (22 units or fewer), else its first 6 characters, "…" and 15 hex of the SHA-256 of the whole
 * id (22 units). The card shows the whole id either way. The earlier form (12 characters and 6 hex, 24 bits) let another id with
 * the same short form be found in seconds.
 */
export function shortPluginId(pluginId: string): string {
  if (pluginId.length <= ID_UNITS) return pluginId;
  return `${pluginId.slice(0, ID_PREFIX)}…${createHash("sha256").update(pluginId, "utf8").digest("hex").slice(0, ID_HASH_HEX)}`;
}

/** Whether the permissions after the grant complete a dangerous combination (none can today: `net:` is not grantable yet). */
export function isDangerous(permissions: readonly string[]): boolean {
  const has = (p: string): boolean => permissions.includes(p) || (p.endsWith(":<origin>") && permissions.some((x) => x.startsWith(p.slice(0, -"<origin>".length)))) || (p.endsWith(":<id>") && permissions.some((x) => x.startsWith(p.slice(0, -"<id>".length))));
  return PLUGIN_DANGEROUS_COMBINATIONS.some((c) => has(c.with) && c.reads.some(has));
}

/**
 * The whole detail line, at most `DIALOG_DETAIL_UNITS` units and free of every class `nativeSummary` would refuse. Throws
 * `DialogOverflow` when the fixed parts cannot fit with `MIN_PROJECT_UNITS` left for the project.
 */
export function grantLine(parts: { readonly wording: string; readonly dangerous: boolean; readonly pluginId: string; readonly projectName: string }): string {
  const head = `${parts.dangerous ? DANGER_MARKER : ""}${sanitise(parts.wording)}: ${sanitise(shortPluginId(parts.pluginId))} in `;
  const room = DIALOG_DETAIL_UNITS - head.length;
  if (room < MIN_PROJECT_UNITS) throw new DialogOverflow();
  const project = sanitise(parts.projectName);
  return head + fitted(project.length > 0 ? project : "?", room);
}
