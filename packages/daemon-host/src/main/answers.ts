// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { settingsResultSchema, type OutboundMessage } from "../control/messages.js";
import type { AnchorHead, AnchorRead, AnchorStore, AnchorUnavailable } from "./anchor-store.js";
import { NativeQueue, type NativeDialogPort, type NativeRefusal, type NativeTimers } from "./native-queue.js";
import { userScopeValue, type SettingInspect } from "./settings-scope.js";
import { isPathTrusted, trustedFolders } from "./trust-model.js";

/**
 * Main's answers to the daemon's requests (ticket X1c, `docs/design/main-answers.md` section 3): `anchor.get` and `anchor.put`,
 * `native.confirm`, `trust.check` and `settings.get`. `onRequest` is the supervisor's hook; the supervisor has already parsed the
 * message with `outboundMessageSchema` and binds `reply` to the generation that asked. Everything that touches the world is a
 * port. Fail closed throughout: an anchor main cannot read is silence (the host starts degraded), an anchor put main cannot make
 * durable is not acknowledged (the host's anchor stalls), a trust question main cannot decide is `false`, a setting it cannot give
 * is silence (the host refuses on its timeout). Events are closed names; no value from a message reaches them.
 */

export interface TrustSource {
  /** The repository path of a project main registered; `undefined` for any other. */
  projectPath(projectId: string): string | undefined;
  /** The raw Workspace Trust model (`content.trust.model.key`), `undefined` when absent. Renderer-writable: see main-answers.md 3.3. */
  trustModel(): string | undefined;
}

export interface SettingsSource {
  inspect(key: string): SettingInspect;
}

export type MainAnswerEvent =
  | { readonly event: "anchor_unavailable"; readonly reason: AnchorUnavailable }
  | { readonly event: "anchor_put_refused"; readonly reason: "store_unreadable" | "regression" | "write_failed" }
  | { readonly event: "native_refused"; readonly reason: NativeRefusal }
  | { readonly event: "trust_refused" }
  | { readonly event: "settings_unanswered" };

export interface MainAnswersOptions {
  readonly anchors: AnchorStore;
  readonly dialog: NativeDialogPort;
  /** The broker's window table: an identity's window id to a live code window. */
  readonly windows: { codeWindowOf(windowId: string): number | undefined };
  readonly trust: TrustSource;
  readonly settings: SettingsSource;
  readonly platform: "darwin" | "linux" | "win32";
  /** Monotonic milliseconds. */
  readonly now: () => number;
  readonly onEvent?: (event: MainAnswerEvent) => void;
  readonly nativeTtlMs?: number;
  readonly nativeMaxWaiting?: number;
  /** The bound of an open native dialog (default: the global timers). */
  readonly nativeTimers?: NativeTimers;
}

type Reply = (message: unknown) => void;

export interface MainAnswers {
  /** Read the anchor store once, before the first spawn (so a keychain prompt cannot use up the host's 5 s). Idempotent. */
  prepare(): Promise<void>;
  /** The supervisor's `onRequest`. Never throws. */
  onRequest(message: OutboundMessage, reply: Reply): void;
  /** Resolves when no anchor write is in flight (for tests and shutdown). */
  idle(): Promise<void>;
  dispose(): void;
}

export function createMainAnswers(options: MainAnswersOptions): MainAnswers {
  const emit = (e: MainAnswerEvent): void => {
    try {
      options.onEvent?.(e);
    } catch {
      // an observer never changes an answer
    }
  };
  let disposed = false;
  const native = new NativeQueue({
    dialog: options.dialog,
    codeWindowOf: (w) => options.windows.codeWindowOf(w),
    now: options.now,
    ...(options.nativeTtlMs === undefined ? {} : { ttlMs: options.nativeTtlMs }),
    ...(options.nativeMaxWaiting === undefined ? {} : { maxWaiting: options.nativeMaxWaiting }),
    ...(options.nativeTimers === undefined ? {} : { timers: options.nativeTimers }),
    onRefused: (reason) => emit({ event: "native_refused", reason }),
  });

  // ---- the anchor ----------------------------------------------------------------------------------------------
  /** What the store said; `stale` after a failed write (re-read before it is trusted again). */
  let cache: AnchorRead | "stale" | undefined;
  let reading: Promise<AnchorRead> | undefined;
  let prepared: Promise<void> | undefined;
  let next: { head: AnchorHead; reply: Reply } | undefined;
  let writing: Promise<void> | undefined;

  const current = (): Promise<AnchorRead> => {
    if (cache !== undefined && cache !== "stale") return Promise.resolve(cache);
    reading ??= options.anchors
      .read()
      .catch((): AnchorRead => ({ kind: "unavailable", reason: "read_failed" }))
      .then((r) => {
        cache = r;
        reading = undefined;
        if (r.kind === "unavailable") emit({ event: "anchor_unavailable", reason: r.reason });
        return r;
      });
    return reading;
  };

  const answerGet = async (requestId: string, reply: Reply): Promise<void> => {
    await prepared;
    const r = await current();
    if (disposed) return;
    // Silence for anything but a record or a definite absence: the host reads it as `anchor_unreachable`, never a first start.
    if (r.kind === "unavailable") return;
    reply({ type: "anchor.result", requestId, anchor: r.kind === "anchor" ? { seq: r.head.seq, hash: r.head.hash } : null });
  };

  const drain = async (): Promise<void> => {
    while (next !== undefined && !disposed) {
      const { head, reply } = next;
      next = undefined;
      const r = await current();
      if (r.kind === "unavailable") {
        emit({ event: "anchor_put_refused", reason: "store_unreadable" });
        continue;
      }
      if (r.kind === "anchor") {
        if (head.seq < r.head.seq || (head.seq === r.head.seq && head.hash !== r.head.hash)) {
          emit({ event: "anchor_put_refused", reason: "regression" });
          continue;
        }
        if (head.seq === r.head.seq) {
          reply({ type: "anchor.ack", seq: head.seq });
          continue;
        }
      }
      try {
        await options.anchors.write(head);
      } catch {
        cache = "stale";
        emit({ event: "anchor_put_refused", reason: "write_failed" });
        continue;
      }
      cache = { kind: "anchor", head };
      if (!disposed) reply({ type: "anchor.ack", seq: head.seq });
    }
  };

  const put = (head: AnchorHead, reply: Reply): void => {
    // Merged into the newest (an ack is cumulative); a put below the one already waiting is a regression.
    if (next !== undefined && head.seq < next.head.seq) {
      emit({ event: "anchor_put_refused", reason: "regression" });
      return;
    }
    next = { head, reply };
    writing ??= drain().finally(() => void (writing = undefined));
  };

  // ---- trust and settings --------------------------------------------------------------------------------------
  const trusted = (windowId: string, projectId: string): boolean => {
    try {
      if (options.windows.codeWindowOf(windowId) === undefined) return false;
      const path = options.trust.projectPath(projectId);
      if (typeof path !== "string") return false;
      return isPathTrusted(path, trustedFolders(options.trust.trustModel(), options.platform), options.platform);
    } catch {
      return false;
    }
  };

  const settingsAnswer = (requestId: string, key: string): unknown => {
    let value: unknown;
    try {
      value = userScopeValue(options.settings.inspect(key));
    } catch {
      return undefined;
    }
    // The exact schema the host reads the answer with: a value it would refuse is not sent (silence is the refusal).
    const parsed = settingsResultSchema.safeParse({ type: "settings.result", requestId, key, value });
    return parsed.success ? parsed.data : undefined;
  };

  const safeReply = (reply: Reply, message: unknown): void => {
    try {
      reply(message);
    } catch {
      // closed
    }
  };

  return {
    prepare(): Promise<void> {
      prepared ??= current().then(() => undefined);
      return prepared;
    },
    onRequest(message, reply): void {
      if (disposed) return;
      const send: Reply = (m) => safeReply(reply, m);
      try {
        switch (message.type) {
          case "anchor.get":
            void answerGet(message.requestId, send);
            return;
          case "anchor.put":
            put({ seq: message.seq, hash: message.hash }, send);
            return;
          case "native.confirm":
            native.push({ challengeId: message.challengeId, proof: message.proof, windowId: message.windowId, summary: message.summary }, send);
            return;
          case "trust.check": {
            const ok = trusted(message.windowId, message.projectId);
            if (!ok) emit({ event: "trust_refused" });
            send({ type: "trust.result", requestId: message.requestId, trusted: ok });
            return;
          }
          case "settings.get": {
            const answer = settingsAnswer(message.requestId, message.key);
            if (answer === undefined) emit({ event: "settings_unanswered" });
            else send(answer);
            return;
          }
          default:
            return;
        }
      } catch {
        // a failing answer is no answer
      }
    },
    idle: async (): Promise<void> => {
      while (writing !== undefined) await writing;
    },
    dispose(): void {
      disposed = true;
      next = undefined;
      native.dispose();
    },
  };
}
