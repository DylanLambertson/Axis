// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { z } from "zod";
import type { ToolDefinition } from "@axis/broker";
import type { ComposerMessaging } from "../messages/participation.js";
import { PagesRefusal, type PagesService } from "../pages/service.js";
import type { ComposerToolSpec } from "../ports/composer.js";
import { MESSAGE_TOOL_SPECS, MessagesRead, messageTools } from "./agent-messages.js";
import { PAGE_TOOL_SPECS, PageRead, WRITE_PAGE, pageTools, writePageArgs, writePagePreview } from "./agent-pages.js";

/**
 * The broker tools a composer run gets only for its worker (messaging PV-M4, pages PV-Q1 slice 2): which are offered, their
 * specs, their approval previews, and how a taint-carrying read result is unwrapped. Moved out of `agent.ts` unchanged.
 *
 * - Messaging is offered when the host's messaging knows the run's agent (`messaging.agentOf`).
 * - Pages are offered when the run has a live worker (`pages.workerOf`); the worker is asked again at every call, so a worker
 *   archived while its run lives loses the page tools (PV-Q1 slice 2 review 1 N1).
 */
export interface OptionalToolsDeps {
  readonly runId: string;
  readonly messaging: ComposerMessaging | undefined;
  readonly pages: { readonly service: PagesService; readonly workerOf: (runId: string) => { readonly agentId: string; readonly projectId: string } | undefined } | undefined;
  /** The run's received hop at the moment of a call. */
  readonly receivedHop: () => number;
}

export type ToolPreview = { readonly args: z.ZodType; readonly content: (args: never) => string | undefined };

export interface OptionalTools {
  readonly tools: readonly ToolDefinition[];
  readonly specs: readonly ComposerToolSpec[];
  readonly previews: ReadonlyArray<readonly [string, ToolPreview]>;
}

export function optionalTools(d: OptionalToolsDeps): OptionalTools {
  const tools: ToolDefinition[] = [];
  const specs: ComposerToolSpec[] = [];
  const previews: (readonly [string, ToolPreview])[] = [];
  const agentId = d.messaging?.agentOf(d.runId);
  if (d.messaging !== undefined && agentId !== undefined) {
    tools.push(...messageTools({ messaging: d.messaging, who: () => ({ agentId, runId: d.runId, receivedHop: d.receivedHop() }) }));
    specs.push(...MESSAGE_TOOL_SPECS);
  }
  const pages = d.pages;
  const worker = pages?.workerOf(d.runId);
  if (pages !== undefined && worker !== undefined) {
    const pageWho = () => {
      const now = pages.workerOf(d.runId);
      if (now === undefined || now.agentId !== worker.agentId) throw new PagesRefusal("E_NOT_FOUND", "not_found");
      return { kind: "agent" as const, agentId: now.agentId, projectId: now.projectId, runId: d.runId, receivedHop: d.receivedHop() };
    };
    previews.push([WRITE_PAGE, { args: writePageArgs, content: writePagePreview(pages.service, pageWho) as never }]);
    tools.push(...pageTools({ pages: pages.service, who: pageWho }));
    specs.push(...PAGE_TOOL_SPECS);
  }
  return { tools, specs, previews };
}

/** A read that carries taint receipts (IAC-T sources 2 and 4): its receipts, to take BEFORE its text is returned. */
export function taintedRead(out: unknown): { readonly receipts: readonly unknown[]; readonly content: string } | undefined {
  if (out instanceof PageRead) return { receipts: out.receipt === undefined ? [] : [out.receipt], content: out.text };
  if (out instanceof MessagesRead) return { receipts: out.outcome.receipts, content: out.outcome.text };
  return undefined;
}
