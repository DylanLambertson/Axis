// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { toDisplayPath } from "@axis/protocol";
import type { InboundMessage, OutboundMessage } from "../control/messages.js";
import type { ChoiceRequest, NativeRefusal } from "./native-queue.js";

/**
 * Main's project actions (docs/design/project-registration-and-trust.md §4): the renderer asks with `{ nonce, action }` only; main
 * takes the folder from THAT window's opened workspace, shows its own native dialog on the shared queue, and only then sends the
 * daemon `projects.register` or `projects.trust`. Electron-free: the overlay passes the sender's code window (after the connect
 * sender checks), the window's folder, the Workspace Trust model check and the dialog.
 *
 * - The payload is strict: a nonce (correlation only, grants nothing; reuse is harmless because every grant needs a fresh click)
 *   and one of three actions. A path, a project id or any other field is refused.
 * - One action per window at a time, at most 6 a minute per window, and after a dialog for a folder ends in Cancel or expiry the
 *   same action for that folder is refused `busy` for 60 s (at most 64 folders remembered; the oldest goes first).
 * - Cancel is the first button, the default and the cancel id; no grant is ever the default.
 * - `untrust` has no dialog: it only lowers privilege.
 * - `status` has no dialog and changes nothing: it inspects the window's folder and answers one of three closed outcomes
 *   (`status_trusted`, `status_read_only`, `status_not_registered`), never a project id, name or path. It has its own bucket
 *   (one in flight and at most 20 a minute per window) so a view asking cannot use up the dialog actions' limit, and no cooldown.
 */
export const PROJECT_ACTIONS = ["add", "trust", "untrust", "status"] as const;
export type ProjectAction = (typeof PROJECT_ACTIONS)[number];
export const PROJECT_OUTCOMES = ["added", "added_read_only", "trusted", "untrusted", "cancelled", "expired", "no_folder", "not_a_repository", "refused", "busy", "unavailable", "status_trusted", "status_read_only", "status_not_registered"] as const;
export type ProjectOutcome = (typeof PROJECT_OUTCOMES)[number];

export const projectActionSchema = z.strictObject({ nonce: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), action: z.enum(PROJECT_ACTIONS) });

export const ACTIONS_PER_MINUTE = 6;
export const STATUS_PER_MINUTE = 20;
export const COOLDOWN_MS = 60_000;
export const MAX_COOLDOWNS = 64;
export const PROJECT_REQUEST_TIMEOUT_MS = 15_000;

/** A choice dialog as main shows it: Cancel is index 0, the default and the cancel id. */
export interface ProjectDialog {
  readonly message: string;
  readonly detail: string;
  readonly buttons: readonly string[];
}

export interface ProjectActionsOptions {
  /** Post a project message to the host (`DaemonSupervisor.sendProject`); false when it is not running. */
  readonly send: (message: Extract<InboundMessage, { type: "projects.inspect" | "projects.register" | "projects.trust" }>) => boolean;
  /** The shared native queue (`MainAnswers.choose`). */
  readonly choose: (choice: ChoiceRequest) => void;
  /** Show one dialog modal on the code window; the index of the button pressed. */
  readonly show: (codeWindowId: number, dialog: ProjectDialog, signal: AbortSignal) => Promise<number>;
  /** The window's single `file:` folder (absolute, normalised), or undefined (none, multi-root, remote). */
  readonly windowFolder: (codeWindowId: number) => string | undefined;
  /** The Workspace Trust model trusts this path now (renderer-writable: never the grant, only what the dialog offers). */
  readonly workspaceTrusted: (path: string) => boolean;
  /** Monotonic milliseconds. */
  readonly now: () => number;
  readonly requestTimeoutMs?: number;
}

type Answer = Extract<OutboundMessage, { type: "projects.inspected" | "projects.result" }>;
type Inspected = Extract<Answer, { type: "projects.inspected"; ok: true }>;

export interface ProjectActions {
  /** One renderer request from `codeWindowId` (resolved by main from the IPC sender). Never throws. */
  act(codeWindowId: number, payload: unknown): Promise<{ readonly nonce: string; readonly outcome: ProjectOutcome } | undefined>;
  /** A code window closed: its rate-limit and in-flight entries go (nothing per window outlives it). */
  windowClosed(codeWindowId: number): void;
  /** `projects.inspected` / `projects.result` from the host; true when it answered one of ours. */
  answer(message: OutboundMessage): boolean;
  dispose(): void;
}

const show = (p: string): string => toDisplayPath(p, 240);

function remoteLine(i: Inspected): string {
  if (!i.remoteKnown) return "Remote: unknown";
  if (i.remote === null) return "Remote: none";
  const more = i.remotes > 1 ? ` and ${i.remotes - 1} more` : "";
  return `Remote (as configured in the repository, not verified): ${i.remote.name} ${i.remote.url}${more}`;
}

/** The dialogs of design §4.2. `offerTrust` is the Workspace Trust model at the moment the dialog is shown. */
export function addDialog(folder: string, i: Inspected, offerTrust: boolean): ProjectDialog {
  return {
    message: "Add this repository to Axis?",
    detail: [
      `Folder: ${show(folder)}`,
      remoteLine(i),
      "Axis will read its status and diffs. CLI and agent runs, commits and pushes need \"Trust to run\".",
      ...(offerTrust ? [] : ["To allow runs, commits and pushes, trust the folder in the workbench first."]),
    ].join("\n"),
    buttons: offerTrust ? ["Cancel", "Add read-only", "Add and trust to run"] : ["Cancel", "Add read-only"],
  };
}

export function trustDialog(folder: string, i: Inspected): ProjectDialog {
  return {
    message: "Trust this repository to run?",
    detail: [`Folder: ${show(folder)}`, remoteLine(i), "CLI and agent runs, commits and pushes will be allowed in its workspaces. Only trust code you know."].join("\n"),
    buttons: ["Cancel", "Trust to run"],
  };
}

export function createProjectActions(o: ProjectActionsOptions): ProjectActions {
  const pending = new Map<string, (a: Answer | undefined) => void>();
  const busy = new Set<number>();
  const recent = new Map<number, number[]>();
  const statusBusy = new Set<number>();
  const statusRecent = new Map<number, number[]>();
  const cooldown = new Map<string, number>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let disposed = false;
  let seq = 0;

  const request = (body: { type: "projects.inspect"; path: string } | { type: "projects.register"; path: string; commonDir: string; trusted: boolean } | { type: "projects.trust"; projectId: string; path: string; commonDir?: string; trusted: boolean }): Promise<Answer | undefined> =>
    new Promise((resolve) => {
      const requestId = `pa-${++seq}-${randomBytes(6).toString("hex")}`;
      const timer = setTimeout(() => settle(undefined), o.requestTimeoutMs ?? PROJECT_REQUEST_TIMEOUT_MS);
      timers.add(timer);
      const settle = (a: Answer | undefined): void => {
        clearTimeout(timer);
        timers.delete(timer);
        pending.delete(requestId);
        resolve(a);
      };
      pending.set(requestId, settle);
      if (disposed || !o.send({ ...body, requestId } as never)) settle(undefined);
    });

  const cooling = (key: string): boolean => {
    const until = cooldown.get(key);
    if (until === undefined) return false;
    if (o.now() < until) return true;
    cooldown.delete(key);
    return false;
  };
  const coolDown = (key: string): void => {
    cooldown.delete(key);
    while (cooldown.size >= MAX_COOLDOWNS) cooldown.delete(cooldown.keys().next().value as string);
    cooldown.set(key, o.now() + COOLDOWN_MS);
  };

  const choose = (codeWindowId: number, dialog: ProjectDialog): Promise<{ index: number } | { refused: NativeRefusal }> =>
    new Promise((resolve) => o.choose({ codeWindowId, show: (w, signal) => o.show(w, dialog, signal), done: resolve }));

  const inspect = async (folder: string): Promise<Inspected | ProjectOutcome> => {
    const a = await request({ type: "projects.inspect", path: folder });
    if (a === undefined || a.type !== "projects.inspected") return "unavailable";
    if (a.ok) return a;
    if (a.reason === "not_a_repository") return "not_a_repository";
    return a.code === "E_UNAVAILABLE" || a.code === "E_BACKPRESSURE" ? "unavailable" : "refused";
  };
  const result = (a: Answer | undefined, ok: ProjectOutcome): ProjectOutcome =>
    a === undefined || a.type !== "projects.result" ? "unavailable" : a.ok ? ok : a.code === "E_UNAVAILABLE" || a.code === "E_BACKPRESSURE" ? "unavailable" : "refused";
  const ended = (r: { refused: NativeRefusal }, key: string): ProjectOutcome => {
    if (r.refused === "expired") {
      coolDown(key);
      return "expired";
    }
    return r.refused === "queue_full" ? "busy" : "unavailable";
  };

  async function status(codeWindowId: number): Promise<ProjectOutcome> {
    const folder = o.windowFolder(codeWindowId);
    if (folder === undefined) return "no_folder";
    const i = await inspect(folder);
    // Only the closed status answers, or no_folder / unavailable / refused (a folder that is not a repository is just refused).
    if (typeof i === "string") return i === "not_a_repository" ? "refused" : i;
    return i.registered === undefined ? "status_not_registered" : i.registered.trusted ? "status_trusted" : "status_read_only";
  }

  /** A per-window bucket: false (and nothing recorded) when the window already has `limit` in the last minute. */
  const take = (bucket: Map<number, number[]>, codeWindowId: number, limit: number): boolean => {
    const now = o.now();
    const times = (bucket.get(codeWindowId) ?? []).filter((t) => now - t < 60_000);
    if (times.length >= limit) return false;
    times.push(now);
    bucket.set(codeWindowId, times);
    return true;
  };

  async function run(codeWindowId: number, action: Exclude<ProjectAction, "status">): Promise<ProjectOutcome> {
    const folder = o.windowFolder(codeWindowId);
    if (folder === undefined) return "no_folder";
    const key = `${action}\0${folder}`;
    if (cooling(key)) return "busy";
    const i = await inspect(folder);
    if (typeof i === "string") return i;
    if (action === "untrust") {
      if (i.registered === undefined) return "refused";
      return result(await request({ type: "projects.trust", projectId: i.registered.projectId, path: folder, trusted: false }), "untrusted");
    }
    if (action === "add") {
      if (i.registered !== undefined) return "refused";
      const offerTrust = o.workspaceTrusted(folder);
      const r = await choose(codeWindowId, addDialog(folder, i, offerTrust));
      if ("refused" in r) return ended(r, key);
      if (r.index === 1 || (r.index === 2 && offerTrust)) {
        const trusted = r.index === 2;
        return result(await request({ type: "projects.register", path: folder, commonDir: i.commonDir, trusted }), trusted ? "added" : "added_read_only");
      }
      coolDown(key);
      return "cancelled";
    }
    // trust: a registered, untrusted project whose folder the workbench trusts now. Workspace Trust is read before the dialog only:
    // harmless, because the user's press is the grant and the host checks main's Workspace Trust again at every gated call (T3).
    if (i.registered === undefined) return "refused";
    if (i.registered.trusted) return "trusted";
    if (!o.workspaceTrusted(folder)) return "refused";
    const r = await choose(codeWindowId, trustDialog(folder, i));
    if ("refused" in r) return ended(r, key);
    if (r.index !== 1) {
      coolDown(key);
      return "cancelled";
    }
    return result(await request({ type: "projects.trust", projectId: i.registered.projectId, path: folder, commonDir: i.commonDir, trusted: true }), "trusted");
  }

  return {
    async act(codeWindowId, payload) {
      const parsed = projectActionSchema.safeParse(payload);
      if (!parsed.success || disposed) return undefined;
      const { nonce, action } = parsed.data;
      if (action === "status") {
        if (statusBusy.has(codeWindowId) || !take(statusRecent, codeWindowId, STATUS_PER_MINUTE)) return { nonce, outcome: "busy" };
        statusBusy.add(codeWindowId);
        try {
          return { nonce, outcome: await status(codeWindowId) };
        } catch {
          return { nonce, outcome: "unavailable" };
        } finally {
          statusBusy.delete(codeWindowId);
        }
      }
      if (busy.has(codeWindowId) || !take(recent, codeWindowId, ACTIONS_PER_MINUTE)) return { nonce, outcome: "busy" };
      busy.add(codeWindowId);
      try {
        return { nonce, outcome: await run(codeWindowId, action) };
      } catch {
        return { nonce, outcome: "unavailable" };
      } finally {
        busy.delete(codeWindowId);
      }
    },
    windowClosed(codeWindowId) {
      recent.delete(codeWindowId);
      busy.delete(codeWindowId);
      statusRecent.delete(codeWindowId);
      statusBusy.delete(codeWindowId);
    },
    answer(message) {
      if (message.type !== "projects.inspected" && message.type !== "projects.result") return false;
      const settle = pending.get(message.requestId);
      if (settle === undefined) return false;
      settle(message);
      return true;
    },
    dispose() {
      disposed = true;
      for (const settle of [...pending.values()]) settle(undefined);
      for (const t of timers) clearTimeout(t);
      timers.clear();
    },
  };
}
