// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { base64url, type MainPluginIdentity } from "./attest-sign.js";
import { windowIdOf, type PortPair } from "./connect-broker.js";

/**
 * Main's plugin views (ADR 0008 decisions 3 and 5, ticket PV-K1d). Runs in Electron main: no `electron`, no `@axis/*` package,
 * no Node module; the Electron adapters (the `WebContentsView`, the `ipcMain` hook) come with PV-K3.
 *
 * - **Minted by main at view creation.** `mint` gives each plugin view one connection: a `p<n>` window id from a counter that only
 *   grows in this main process (ids are never reused; the daemon is main's child and does not outlive it, so a restart of main
 *   restarts both, ADR 0008 decision 3), the host's `w<n>` fixed for the view's life, a fresh random `connectionId`, and a
 *   `MainPluginIdentity` signed through the same supervisor path as a window (`trusted: false`: informational, the daemon's
 *   project trust gate decides). The view never asks for a connection.
 * - **Destroyed with its host.** `destroyHost` closes every view of that window, and the host is remembered as dead: a stale window
 *   id can never mint again. `reload` is a new view: the old one is destroyed (port closed) and a new one minted with a new port,
 *   `p<n>` and `connectionId`.
 * - **Bounded:** at most 8 views per host and 64 in all; past either, a closed refusal.
 * - **Every IPC message from a plugin view is dropped** (decision 3): `dropIpc` answers true for a plugin view's `webContents`, so
 *   the hook drops it silently (the plugin learns nothing); one closed event per view and channel, then only a count. No name,
 *   channel text or value reaches an event.
 * - **No enumeration (OI-7):** nothing here lists views, windows or plugins; the only lookups take a `webContents` id main holds.
 */

export const PLUGIN_VIEW_REFUSALS = ["bad_plugin", "bad_project", "bad_view", "host_not_live", "host_full", "views_full", "not_ready"] as const;
export type PluginViewRefusal = (typeof PLUGIN_VIEW_REFUSALS)[number];

export type PluginViewEvent =
  | { readonly event: "plugin_view_minted" }
  | { readonly event: "plugin_view_refused"; readonly reason: PluginViewRefusal }
  | { readonly event: "plugin_view_destroyed" }
  | { readonly event: "plugin_ipc_dropped" };

export interface PluginViewsOptions<P> {
  readonly supervisor: { connect(identity: MainPluginIdentity, port: unknown): boolean };
  readonly createChannel: () => PortPair<P>;
  readonly closePort: (port: P) => void;
  readonly randomBytes: (n: number) => Uint8Array;
  /** True while the code window is open and has a brokered connection (`ConnectBroker.codeWindowOf`). Must not throw (a throw is false). */
  readonly hostLive: (codeWindowId: number) => boolean;
  readonly onEvent?: (event: PluginViewEvent) => void;
  readonly maxViewsPerHost?: number;
  readonly maxViews?: number;
}

export interface MintRequest {
  /** The code window that hosts the view (main's own id, never a renderer claim). */
  readonly hostCodeWindowId: number;
  /** The view's `webContents.id`, as main created it. */
  readonly webContentsId: number;
  /** The installed plugin's id (at most 64 characters, ADR 0008 decision 3). */
  readonly pluginId: string;
  /** The project the plugin is enabled in. */
  readonly projectId: string;
}

export type MintOutcome<P> = { readonly ok: true; readonly port: P; readonly windowId: string } | { readonly ok: false; readonly reason: PluginViewRefusal };

export const DEFAULT_MAX_VIEWS_PER_HOST = 8;
export const DEFAULT_MAX_VIEWS = 64;
/** Remembered dead hosts (window ids only grow, so the oldest can be forgotten safely beyond this). */
const MAX_DEAD_HOSTS = 4096;
/** Channels remembered per view for the once-per-channel event; past it every drop is only counted. */
const MAX_CHANNELS_PER_VIEW = 32;
const PLUGIN_ID_RE = /^(?=[a-z0-9.-]{1,64}$)[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*){0,3}$/;
const PROJECT_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;

interface View<P> {
  readonly host: number;
  readonly port: P;
  readonly channels: Set<string>;
  dropped: number;
}

const safeId = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

export class PluginViews<P> {
  readonly #o: PluginViewsOptions<P>;
  readonly #perHost: number;
  readonly #max: number;
  /** webContents id -> view. */
  readonly #views = new Map<number, View<P>>();
  /** host code window id -> its views' webContents ids. */
  readonly #byHost = new Map<number, Set<number>>();
  readonly #deadHosts = new Set<number>();
  #counter = 0;

  constructor(options: PluginViewsOptions<P>) {
    this.#o = options;
    this.#perHost = options.maxViewsPerHost ?? DEFAULT_MAX_VIEWS_PER_HOST;
    this.#max = options.maxViews ?? DEFAULT_MAX_VIEWS;
  }

  /** Give a new plugin view its connection. Never throws. */
  mint(request: MintRequest): MintOutcome<P> {
    const refused = (reason: PluginViewRefusal): MintOutcome<P> => {
      this.#emit({ event: "plugin_view_refused", reason });
      return { ok: false, reason };
    };
    if (typeof request !== "object" || request === null) return refused("bad_view");
    const { hostCodeWindowId: host, webContentsId: wc, pluginId, projectId } = request;
    if (typeof pluginId !== "string" || !PLUGIN_ID_RE.test(pluginId)) return refused("bad_plugin");
    if (typeof projectId !== "string" || !PROJECT_ID_RE.test(projectId)) return refused("bad_project");
    if (!safeId(wc) || this.#views.has(wc)) return refused("bad_view");
    if (!safeId(host) || this.#deadHosts.has(host) || !this.#live(host)) return refused("host_not_live");
    if ((this.#byHost.get(host)?.size ?? 0) >= this.#perHost) return refused("host_full");
    if (this.#views.size >= this.#max) return refused("views_full");

    let pair: PortPair<P>;
    try {
      pair = this.#o.createChannel();
    } catch {
      return refused("not_ready");
    }
    // The counter moves for every attempt that reaches here, so an id is never handed out twice, even after a failure.
    this.#counter += 1;
    const windowId = `p${this.#counter}`;
    let sent = false;
    try {
      const bytes = this.#o.randomBytes(16);
      if (bytes.length === 16) {
        const actor = `plugin:${pluginId}` as const;
        const identity: MainPluginIdentity = { connectionId: base64url(bytes), windowId, actorId: actor, actor, workspaceId: projectId, trusted: false, clientKind: "plugin", hostWindowId: windowIdOf(host) };
        sent = this.#o.supervisor.connect(identity, pair.daemonEnd);
      }
    } catch {
      sent = false;
    }
    if (!sent) {
      this.#close(pair.daemonEnd);
      this.#close(pair.rendererEnd);
      return refused("not_ready");
    }
    this.#views.set(wc, { host, port: pair.rendererEnd, channels: new Set(), dropped: 0 });
    let set = this.#byHost.get(host);
    if (set === undefined) {
      set = new Set();
      this.#byHost.set(host, set);
    }
    set.add(wc);
    this.#emit({ event: "plugin_view_minted" });
    return { ok: true, port: pair.rendererEnd, windowId };
  }

  /** The view is gone (destroyed, crashed, navigated): its port is closed, so the daemon drops its connection. */
  destroy(webContentsId: number): boolean {
    const view = this.#views.get(webContentsId);
    if (view === undefined) return false;
    this.#views.delete(webContentsId);
    const set = this.#byHost.get(view.host);
    set?.delete(webContentsId);
    if (set !== undefined && set.size === 0) this.#byHost.delete(view.host);
    this.#close(view.port);
    this.#emit({ event: "plugin_view_destroyed" });
    return true;
  }

  /** A reload is a new view: the old one is destroyed and a new one minted (new port, `p<n>`, connection id). */
  reload(oldWebContentsId: number, request: MintRequest): MintOutcome<P> {
    const old = this.#views.get(oldWebContentsId);
    if (old === undefined || old.host !== request.hostCodeWindowId) {
      this.#emit({ event: "plugin_view_refused", reason: "bad_view" });
      return { ok: false, reason: "bad_view" };
    }
    this.destroy(oldWebContentsId);
    return this.mint(request);
  }

  /** The host window closed: every view it hosts is destroyed, and the window can never host again. */
  destroyHost(hostCodeWindowId: number): void {
    if (!safeId(hostCodeWindowId)) return;
    for (const wc of [...(this.#byHost.get(hostCodeWindowId) ?? [])]) this.destroy(wc);
    this.#deadHosts.add(hostCodeWindowId);
    if (this.#deadHosts.size > MAX_DEAD_HOSTS) {
      const oldest = Math.min(...this.#deadHosts);
      this.#deadHosts.delete(oldest);
    }
  }

  /**
   * For main's IPC hook, before any handler: true when the sender is a plugin view, and the message must be dropped without an
   * answer. One `plugin_ipc_dropped` event per view and channel, then only the view's count grows.
   */
  dropIpc(webContentsId: number, channel: unknown): boolean {
    const view = this.#views.get(webContentsId);
    if (view === undefined) return false;
    view.dropped += 1;
    const key = typeof channel === "string" ? channel.slice(0, 128) : "";
    if (!view.channels.has(key) && view.channels.size < MAX_CHANNELS_PER_VIEW) {
      view.channels.add(key);
      this.#emit({ event: "plugin_ipc_dropped" });
    }
    return true;
  }

  /** True for a `webContents` id main holds as a plugin view. */
  isPluginSender(webContentsId: number): boolean {
    return this.#views.has(webContentsId);
  }

  /** How many messages this view has had dropped (for main's log line when the view goes). */
  droppedCount(webContentsId: number): number {
    return this.#views.get(webContentsId)?.dropped ?? 0;
  }

  #live(host: number): boolean {
    try {
      return this.#o.hostLive(host) === true;
    } catch {
      return false;
    }
  }

  #close(port: P): void {
    try {
      this.#o.closePort(port);
    } catch {
      // already closed
    }
  }

  #emit(event: PluginViewEvent): void {
    try {
      this.#o.onEvent?.(event);
    } catch {
      // an observer never changes the outcome
    }
  }
}
