// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { base64url, type MainPluginIdentity } from "./attest-sign.js";
import { windowIdOf, type PortPair } from "./connect-broker.js";

/**
 * Main's plugin views (ADR 0008 decisions 3 and 5, ticket PV-K1d). Runs in Electron main: no `electron`, no `@axis/*` package,
 * no Node module; the Electron adapters (the `WebContentsView`, the `ipcMain` hook) come with PV-K3.
 *
 * - **Trust assumption.** Every input to `mint` and `reload` comes from main's own tables, never from a renderer or a plugin
 *   message: the host's code window id from main's window registry, the `webContents` id from the `WebContentsView` main
 *   created, the plugin id and project from the installed and enabled plugin record. The four fields are read once.
 * - **Minted by main at view creation.** `mint` gives each plugin view one connection: a `p<n>` window id from a counter that only
 *   grows in this main process (ids are never reused; the daemon is main's child and does not outlive it, ADR 0008 decision 3),
 *   the host's `w<n>` fixed for the view's life, a fresh random `connectionId`, and a `MainPluginIdentity` signed through the
 *   same supervisor path as a window (`trusted: false`: informational, the daemon's project trust gate decides). The view never
 *   asks for a connection.
 * - **Destroyed with its host.** `destroyHost` closes every view of that window, and the host is remembered as dead: a stale window
 *   id can never mint again (also checked again after the supervisor answers, in case that call re-entered). `reload` is the
 *   same view anew: same host, plugin and project, a new port, `p<n>` and `connectionId`.
 * - **Bounded:** at most 8 views per host and 64 in all; past either, a closed refusal.
 * - **Every IPC message from a plugin view is dropped, and stays dropped (fail closed).** A `webContents` that was ever a plugin
 *   view is a tombstone after `destroy` or a refused re-mint: Electron keeps a `webContents` id for its life (a reload keeps it),
 *   so `dropIpc` and `isPluginSender` answer true for it until main reports `webContentsDestroyed`. At most 4,096 tombstones;
 *   past that, a new mint is refused rather than any tombstone forgotten. The drop is silent (the plugin learns nothing); one
 *   closed event per view and channel, then only a count. No name, channel text or value reaches an event.
 * - **PV-K3's requirement:** main's IPC hook calls `dropIpc` before ANY `ipcMain` handler, `handle` and `on` alike, including
 *   every `vscode:` channel, and calls `webContentsDestroyed` from the `webContents` `destroyed` event.
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
  readonly maxTombstones?: number;
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
export const DEFAULT_MAX_TOMBSTONES = 4096;
/** Remembered dead hosts (window ids only grow, so the oldest can be forgotten safely beyond this). */
const MAX_DEAD_HOSTS = 4096;
/** Channels remembered per view for the once-per-channel event; past it every drop is only counted. */
const MAX_CHANNELS_PER_VIEW = 32;
const PLUGIN_ID_RE = /^(?=[a-z0-9.-]{1,64}$)[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*){0,3}$/;
const PROJECT_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;

interface View<P> {
  readonly host: number;
  readonly pluginId: string;
  readonly projectId: string;
  readonly port: P;
  readonly channels: Set<string>;
  dropped: number;
}

const safeId = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

/** The four fields, read once each (a getter cannot answer differently later). */
function snapshot(request: unknown): MintRequest | undefined {
  if (typeof request !== "object" || request === null) return undefined;
  const r = request as Record<string, unknown>;
  const hostCodeWindowId = r["hostCodeWindowId"];
  const webContentsId = r["webContentsId"];
  const pluginId = r["pluginId"];
  const projectId = r["projectId"];
  return Object.freeze({ hostCodeWindowId, webContentsId, pluginId, projectId }) as MintRequest;
}

export class PluginViews<P> {
  readonly #o: PluginViewsOptions<P>;
  readonly #perHost: number;
  readonly #max: number;
  readonly #maxTombstones: number;
  /** webContents id -> view. */
  readonly #views = new Map<number, View<P>>();
  /** webContents ids that were plugin views and may still be alive -> messages dropped since. */
  readonly #tombstones = new Map<number, number>();
  /** host code window id -> its views' webContents ids. */
  readonly #byHost = new Map<number, Set<number>>();
  readonly #deadHosts = new Set<number>();
  #counter = 0;

  constructor(options: PluginViewsOptions<P>) {
    this.#o = options;
    this.#perHost = options.maxViewsPerHost ?? DEFAULT_MAX_VIEWS_PER_HOST;
    this.#max = options.maxViews ?? DEFAULT_MAX_VIEWS;
    this.#maxTombstones = options.maxTombstones ?? DEFAULT_MAX_TOMBSTONES;
  }

  /** Give a new plugin view its connection. Never throws. */
  mint(request: MintRequest): MintOutcome<P> {
    const snap = snapshot(request);
    return snap === undefined ? this.#refused("bad_view") : this.#mint(snap);
  }

  #refused(reason: PluginViewRefusal): MintOutcome<P> {
    this.#emit({ event: "plugin_view_refused", reason });
    return { ok: false, reason };
  }

  #mint(request: MintRequest): MintOutcome<P> {
    const { hostCodeWindowId: host, webContentsId: wc, pluginId, projectId } = request;
    if (typeof pluginId !== "string" || !PLUGIN_ID_RE.test(pluginId)) return this.#refused("bad_plugin");
    if (typeof projectId !== "string" || !PROJECT_ID_RE.test(projectId)) return this.#refused("bad_project");
    if (!safeId(wc) || this.#views.has(wc)) return this.#refused("bad_view");
    if (!safeId(host) || this.#deadHosts.has(host) || !this.#live(host)) return this.#refused("host_not_live");
    if ((this.#byHost.get(host)?.size ?? 0) >= this.#perHost) return this.#refused("host_full");
    if (this.#views.size >= this.#max || (!this.#tombstones.has(wc) && this.#tombstones.size >= this.#maxTombstones)) return this.#refused("views_full");

    let pair: PortPair<P>;
    try {
      pair = this.#o.createChannel();
    } catch {
      return this.#refused("not_ready");
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
    // The supervisor call may have re-entered and destroyed the host: a view never registers under a dead host.
    const hostDied = this.#deadHosts.has(host);
    if (!sent || hostDied) {
      this.#close(pair.daemonEnd);
      this.#close(pair.rendererEnd);
      return this.#refused(hostDied ? "host_not_live" : "not_ready");
    }
    this.#tombstones.delete(wc);
    this.#views.set(wc, { host, pluginId, projectId, port: pair.rendererEnd, channels: new Set(), dropped: 0 });
    let set = this.#byHost.get(host);
    if (set === undefined) {
      set = new Set();
      this.#byHost.set(host, set);
    }
    set.add(wc);
    this.#emit({ event: "plugin_view_minted" });
    return { ok: true, port: pair.rendererEnd, windowId };
  }

  /**
   * The view's connection is gone (destroyed, crashed, navigated, reloading): its port is closed, so the daemon drops it. The
   * `webContents` may still be alive, so it stays a dropped sender until `webContentsDestroyed`.
   */
  destroy(webContentsId: number): boolean {
    const view = this.#views.get(webContentsId);
    if (view === undefined) return false;
    this.#views.delete(webContentsId);
    this.#tombstones.set(webContentsId, view.dropped);
    const set = this.#byHost.get(view.host);
    set?.delete(webContentsId);
    if (set !== undefined && set.size === 0) this.#byHost.delete(view.host);
    this.#close(view.port);
    this.#emit({ event: "plugin_view_destroyed" });
    return true;
  }

  /** Main saw the `webContents` itself destroyed (its `destroyed` event): only now is its id forgotten. */
  webContentsDestroyed(webContentsId: number): void {
    this.destroy(webContentsId);
    this.#tombstones.delete(webContentsId);
  }

  /**
   * A reload is the same view anew: under the same host, for the same plugin and project, a new port, `p<n>` and connection id.
   * The old connection is closed first; if the new one is refused, the `webContents` stays a dropped sender.
   */
  reload(oldWebContentsId: number, request: MintRequest): MintOutcome<P> {
    const snap = snapshot(request);
    const old = this.#views.get(oldWebContentsId);
    if (snap === undefined || old === undefined || old.host !== snap.hostCodeWindowId || old.pluginId !== snap.pluginId || old.projectId !== snap.projectId) return this.#refused("bad_view");
    this.destroy(oldWebContentsId);
    return this.#mint(snap);
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
   * For main's IPC hook, before any handler: true when the sender is or was a plugin view (until its `webContents` is destroyed),
   * and the message must be dropped without an answer. One `plugin_ipc_dropped` event per live view and channel, then only counts.
   */
  dropIpc(webContentsId: number, channel: unknown): boolean {
    const view = this.#views.get(webContentsId);
    if (view === undefined) {
      const was = this.#tombstones.get(webContentsId);
      if (was === undefined) return false;
      this.#tombstones.set(webContentsId, was + 1);
      return true;
    }
    view.dropped += 1;
    const key = typeof channel === "string" ? channel.slice(0, 128) : "";
    if (!view.channels.has(key) && view.channels.size < MAX_CHANNELS_PER_VIEW) {
      view.channels.add(key);
      this.#emit({ event: "plugin_ipc_dropped" });
    }
    return true;
  }

  /** True for a `webContents` id main holds as a plugin view, or held as one and has not seen destroyed. */
  isPluginSender(webContentsId: number): boolean {
    return this.#views.has(webContentsId) || this.#tombstones.has(webContentsId);
  }

  /** How many messages this sender has had dropped (for main's log line when it goes). */
  droppedCount(webContentsId: number): number {
    return this.#views.get(webContentsId)?.dropped ?? this.#tombstones.get(webContentsId) ?? 0;
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
