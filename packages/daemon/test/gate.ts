// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { createHash } from "node:crypto";
import type { Challenge } from "@axis/protocol";
import { ApprovalError, type ActorId, type ApprovalContent, type ApprovalGate, type ApprovalInput } from "../src/index.js";

interface Record_ {
  readonly digest: string;
  readonly target: string;
  readonly contentDigest: string;
  readonly actor: ActorId;
  readonly connectionId: string;
  state: "open" | "spent" | "withdrawn";
}

export const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

/**
 * A small stand-in for the challenge manager behind the gate adapter, with the
 * semantics the gate contract demands: caller binding, digest and target
 * binding, a content check, single use (also when the action fails), and
 * withdrawal. Every call is recorded.
 */
export function fakeGate(options: { mint?: (input: ApprovalInput, content: ApprovalContent) => unknown } = {}) {
  const records = new Map<string, Record_>();
  const calls = {
    issue: [] as Array<{ input: ApprovalInput; content: ApprovalContent }>,
    execute: [] as Array<{ input: ApprovalInput; challengeId: string; content: ApprovalContent }>,
    withdraw: [] as Array<{ challengeId: string; connectionId: string }>,
    withdrawConnection: [] as string[],
    /** What the approval manager would audit around the action, like tier4.execute. */
    audit: [] as string[],
  };
  let n = 0;
  const gate: ApprovalGate = {
    issue(input, content) {
      const challengeId = String(++n).padStart(43, "A");
      records.set(challengeId, {
        digest: input.digest,
        target: content.target,
        contentDigest: content.contentDigest,
        actor: input.actor,
        connectionId: input.connectionId,
        state: "open",
      });
      calls.issue.push({ input, content });
      const challenge: Challenge = {
        challengeId,
        digest: sha(JSON.stringify([3, input.digest, content.target, content.contentDigest])),
        contract: `${input.contract}/${input.contractVersion}`,
        method: input.method,
        tier: input.tier as 4,
        targetSummary: "target",
        nativeConfirmationRequired: true,
        expiresAt: 2_000_000_000_000,
      };
      return challenge;
    },
    async execute(input, ref, content, action) {
      calls.execute.push({ input, challengeId: ref.challengeId, content });
      const rec = records.get(ref.challengeId);
      if (!rec || rec.actor !== input.actor || rec.connectionId !== input.connectionId) throw new ApprovalError("E_POLICY_DENIED");
      if (rec.state !== "open") throw new ApprovalError("E_CONFLICT");
      if (rec.digest !== input.digest || rec.target !== content.target) {
        rec.state = "spent";
        throw new ApprovalError("E_POLICY_DENIED");
      }
      if (rec.contentDigest !== content.contentDigest) {
        rec.state = "spent";
        throw new ApprovalError("E_CONFLICT");
      }
      rec.state = "spent";
      calls.audit.push("authorised");
      // Minted after the spend, bound to the target and the content digest, handed to the handler through the action.
      const capability = options.mint?.(input, content);
      try {
        const result = await action({ method: input.method, target: rec.target, requester: rec.actor, ...(capability !== undefined ? { capability } : {}) });
        calls.audit.push("completed success");
        return result;
      } catch {
        calls.audit.push("completed error");
        throw new ApprovalError("E_CONFLICT", true);
      }
    },
    withdraw(challengeId, caller) {
      calls.withdraw.push({ challengeId, connectionId: caller.connectionId });
      const rec = records.get(challengeId);
      if (rec && rec.actor === caller.actor && rec.connectionId === caller.connectionId && rec.state === "open") rec.state = "withdrawn";
    },
    withdrawConnection(connectionId) {
      calls.withdrawConnection.push(connectionId);
      for (const rec of records.values()) if (rec.connectionId === connectionId && rec.state === "open") rec.state = "withdrawn";
    },
  };
  return { gate, calls, records };
}

/**
 * The renderer's two steps: ask, read the challenge, retry with `approval`
 * (the same idempotency key). Returns the id of the retry; `confirm` runs
 * between the steps (for example to change the content).
 */
export async function approveAndRun(
  r: import("./harness.js").Rig,
  prefix: string,
  payload: Record<string, unknown>,
  confirm?: () => void,
  conn?: { client: { postMessage(m: unknown): void }; inbox: import("./harness.js").Rig["inbox"] },
  keyed = true,
): Promise<string> {
  const { req, KEY1 } = await import("./harness.js");
  const method = payload["__method"] === undefined ? "danger" : String(payload["__method"]);
  const key = payload["__key"] === undefined ? KEY1 : String(payload["__key"]);
  payload = Object.fromEntries(Object.entries(payload).filter(([k]) => k !== "__method" && k !== "__key"));
  const client = conn?.client ?? r.client;
  const inbox = conn?.inbox ?? r.inbox;
  client.postMessage(req(`${prefix}-1`, method, payload, { ...(keyed ? { idempotencyKey: key } : {}) }));
  const first = await inbox.response(`${prefix}-1`);
  const challenge = (first.error?.details as { challenge: Challenge }).challenge;
  confirm?.();
  client.postMessage(req(`${prefix}-2`, method, { ...payload, approval: { challengeId: challenge.challengeId } }, { ...(keyed ? { idempotencyKey: key } : {}) }));
  return `${prefix}-2`;
}
