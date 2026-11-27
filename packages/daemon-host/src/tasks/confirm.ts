// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { createHash } from "node:crypto";
import type { ApprovalContentHook } from "@axis/daemon";
import type { Journal } from "@axis/journal";
import { startState } from "./start.js";

/**
 * The approval content of the tier-4 tasks methods (`start`, `delete`; PV-T1 slice 2b): what main's native dialog says the
 * confirmation is for, and what the approval is bound to (the pages pattern, `pages/confirm.ts`).
 *
 * - **Target** `task:<taskId>`; **content digest** over the method, the task's id, project and newest revision, and for
 *   `start` the worker and the digest of the prompt built now. A task that changes between the dialog and the action (a
 *   new revision, a delete) no longer matches, and the approval is refused (`E_CONFLICT`).
 * - **The dialog line** is built only from values the daemon derives: the task id, the revision, whether the text is only
 *   the user's (and if not, the latest other author's kind and the hop), the worker's kind and name (which the user chose),
 *   and for `delete` the project's display name. Never the task's title or body: a worker or a plugin may have written them.
 *   For `start` the trust of the text comes first, then the first 12 characters of the task id (the approval binds the whole
 *   id; ids are random, so the prefix matches the card's), the revision and the worker's name, cut to what is left of the
 *   dialog's 80 units and with any unsafe character shown as `?`, so the line is never cut in the middle or dropped.
 */
export interface TasksConfirmDeps {
  readonly journal: Pick<Journal, "tasks" | "agents" | "getProject" | "getWorkspace">;
  readonly onPreview: (target: string, contentDigest: string, text: string) => void;
}

const MISSING = "0".repeat(64);
/**
 * The dialog cuts its detail at 80 UTF-16 units in the MIDDLE and drops a detail holding a control, format (bidi,
 * zero-width), surrogate or separator character for the bare target (`gate/summary.ts`). The Start line is built to fit
 * those units and to hold none of those characters, so it is never cut or dropped and its trust marker always shows.
 */
export const DIALOG_DETAIL_UNITS = 80;
const UNSAFE = /[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/gu;
const short = (id: string): string => (id.length > 13 ? `${id.slice(0, 12)}…` : id);
/** `t` with unsafe characters made `?`, cut by whole code points to at most `units` UTF-16 units (the cut ends in "…"). */
const fitted = (t: string, units: number): string => {
  const clean = t.replace(/\p{Z}+/gu, " ").replace(UNSAFE, "?");
  if (clean.length <= units) return clean;
  let out = "";
  for (const p of clean) {
    if (out.length + p.length > units - 1) break;
    out += p;
  }
  return `${out}…`;
};
const field = (payload: unknown, key: string): unknown => (typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>)[key] : undefined);

export function taskContent(journal: TasksConfirmDeps["journal"], method: "start" | "delete", payload: unknown): { readonly digest: string; readonly text: string | undefined } {
  const taskId = field(payload, "taskId");
  if (typeof taskId !== "string") return { digest: MISSING, text: undefined };
  let s: ReturnType<typeof startState>;
  try {
    s = startState(journal, taskId);
  } catch {
    return { digest: MISSING, text: undefined }; // the handler refuses: not_found
  }
  const parts: (string | number | boolean)[] = [method, taskId, s.task.projectId, s.seq];
  let text: string;
  if (method === "start") {
    const worker = field(payload, "worker");
    const a = typeof worker === "string" ? journal.agents.get(worker) : undefined;
    if (a === undefined) return { digest: MISSING, text: undefined };
    parts.push(a.id, s.digest);
    const latest = journal.tasks.revisions(taskId).map((m) => m.author).find((x) => x.kind !== "user");
    const trust = s.task.untrusted ? `UNTRUSTED (${latest?.kind ?? "other"}, hop ${s.task.hop})` : "the user's text";
    const head = `${trust}: task ${short(taskId)} r${s.seq} to `; // at most 72 units: the name gets the rest, at least 8
    text = head + fitted(a.name, Math.max(1, DIALOG_DETAIL_UNITS - head.length));
  } else {
    const project = journal.getProject(s.task.projectId)?.displayName ?? s.task.projectId;
    text = `task ${taskId}, all ${s.seq} revisions, in ${project}`;
  }
  return { digest: createHash("sha256").update(JSON.stringify(parts)).digest("hex"), text };
}

export function createTasksContentHooks(deps: TasksConfirmDeps): { readonly start: ApprovalContentHook; readonly delete: ApprovalContentHook } {
  const hook = (method: "start" | "delete"): ApprovalContentHook => (_ctx, payload) => {
    const id = field(payload, "taskId");
    const target = `task:${typeof id === "string" && id.length > 0 ? id : "unknown"}`;
    return {
      target,
      withLock: async (fn) => {
        const { digest, text } = taskContent(deps.journal, method, payload);
        if (text !== undefined) deps.onPreview(target, digest, text);
        return fn(digest);
      },
    };
  };
  return { start: hook("start"), delete: hook("delete") };
}
