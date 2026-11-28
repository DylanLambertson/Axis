// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { APP_URL } from "./stable-ids.js";

/**
 * Main's table of the app windows it created (ADR 0011 Decision 2, "Sender checks move to our own window registry"). It replaces
 * Code OSS's `IWindowsMainService.getWindowByWebContents`: a sender is an app window only when main registered its `webContents`
 * here. The ordered sender checks of `main-answers.md` §2 that need only the window are `checkAppSender`'s; the per-window token
 * bucket and the supervisor state stay in the connect broker (OS-3).
 *
 * - Window ids are main's own, from 1, and never reused, so an identity `w<id>` of a closed window never names a new one.
 * - A frame passes only when its URL is exactly `APP_URL`. The renderer therefore keeps its URL: it routes in memory, never with
 *   `pushState` or a fragment.
 * - On `close`, every `onClosed` listener runs (rate buckets, in-flight project actions, a waiting dialog, the binding and the
 *   status are pruned by their owners, OS-3), each guarded so one throwing listener cannot keep the others from running.
 * - Plugin views are never registered here; they never pass the sender checks (ADR 0008).
 */

export interface AppWindowEntry {
  /** Main's window id: `w<id>` in the identity. */
  readonly id: number;
  /** Electron `webContents.id` of the window's renderer. */
  readonly webContentsId: number;
  /** The one URL its main frame must have. */
  readonly appUrl: string;
}

/** What main itself knows about an IPC sender (never anything the renderer said). */
export interface AppSender {
  /** `event.sender.id`. */
  readonly webContentsId: number | undefined;
  /** `event.senderFrame?.url`. */
  readonly frameUrl: string | undefined;
  /** `event.senderFrame === event.sender.mainFrame`. */
  readonly isMainFrame: boolean;
  /** `event.sender.isDestroyed()`. */
  readonly destroyed: boolean;
}

export const APP_SENDER_REFUSALS = ["not_app_window", "bad_frame", "not_main_frame", "destroyed"] as const;
export type AppSenderRefusal = (typeof APP_SENDER_REFUSALS)[number];

export const DEFAULT_MAX_WINDOWS = 64;

const isId = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

export class WindowRegistry {
  readonly #byId = new Map<number, AppWindowEntry>();
  readonly #byContents = new Map<number, AppWindowEntry>();
  readonly #listeners = new Set<(id: number) => void>();
  readonly #max: number;
  readonly #appUrl: string;
  #next = 1;

  constructor(options: { readonly maxWindows?: number; readonly appUrl?: string } = {}) {
    this.#max = options.maxWindows ?? DEFAULT_MAX_WINDOWS;
    this.#appUrl = options.appUrl ?? APP_URL;
  }

  /** Registers a window main just created. Undefined when the table is full or the `webContents` is already registered. */
  add(webContentsId: number): AppWindowEntry | undefined {
    if (!isId(webContentsId) || this.#byContents.has(webContentsId) || this.#byId.size >= this.#max) return undefined;
    const entry: AppWindowEntry = Object.freeze({ id: this.#next++, webContentsId, appUrl: this.#appUrl });
    this.#byId.set(entry.id, entry);
    this.#byContents.set(webContentsId, entry);
    return entry;
  }

  get(id: number): AppWindowEntry | undefined {
    return this.#byId.get(id);
  }

  byWebContents(webContentsId: number | undefined): AppWindowEntry | undefined {
    return isId(webContentsId) ? this.#byContents.get(webContentsId) : undefined;
  }

  has(id: number): boolean {
    return this.#byId.has(id);
  }

  get size(): number {
    return this.#byId.size;
  }

  /** Called from the window's `closed` event. Removes the entry, then runs every listener. False when it was not registered. */
  close(id: number): boolean {
    const entry = this.#byId.get(id);
    if (entry === undefined) return false;
    this.#byId.delete(id);
    this.#byContents.delete(entry.webContentsId);
    for (const listener of [...this.#listeners]) {
      try {
        listener(id);
      } catch {
        // A pruning owner that throws must not keep the others from pruning.
      }
    }
    return true;
  }

  /** A listener for every closed window; returns its removal. */
  onClosed(listener: (id: number) => void): () => void {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  }

  /**
   * The window-level sender checks, in order (the first failure refuses): a registered app window, the frame URL exactly the
   * window's app URL, the main frame, not destroyed. The window id, or the refusal.
   */
  checkAppSender(sender: AppSender): number | AppSenderRefusal {
    const entry = this.byWebContents(sender.webContentsId);
    if (entry === undefined) return "not_app_window";
    if (typeof sender.frameUrl !== "string" || sender.frameUrl !== entry.appUrl) return "bad_frame";
    if (sender.isMainFrame !== true) return "not_main_frame";
    if (sender.destroyed !== false) return "destroyed";
    return entry.id;
  }
}
