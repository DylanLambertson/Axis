// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// TEST ONLY: the composer options of the headless slice host (ticket C7), read from the JSON file `AXIS_SLICE_COMPOSER` names.
// A scripted mock provider (one script per scenario, chosen by the prompt's `[s:<name>]` tag, one reply per model turn) and,
// when asked, the Anthropic connection over a fake vault backend whose `fetch` reaches only a loopback mock of the API.
import { readFileSync, realpathSync } from "node:fs";
import type { MockReply, RunBudgetLimits, ValidRequest } from "@axis/providers";
import type { ComposeOptions } from "../src/compose.js";
import type { ToolCaps } from "../src/composer/loop.js";
import { fakeBackend } from "../test/anthropic-server.js";

export interface SliceComposerConfig {
  /** Replies per scenario; turn n of a run answers `scripts[tag][n]`, and a turn past the end answers the text `done`. */
  readonly scripts?: Readonly<Record<string, readonly MockReply[]>>;
  readonly budget?: RunBudgetLimits;
  readonly workspaceBudget?: RunBudgetLimits;
  readonly maxTurns?: number;
  readonly toolCaps?: Partial<ToolCaps>;
  /** The Anthropic connection: the loopback port of the test's mock API and the key the fake vault holds. */
  readonly anthropic?: { readonly connectionId: string; readonly port: number; readonly key: string };
}

/** The one origin the adapter may ask; anything else is refused before a socket is opened. */
const API_ORIGIN = "https://api.anthropic.com";
/** In a script, this string stands for the real path of the node binary running the host (a native program everywhere). */
export const NODE_TOKEN = "$NODE";

const tagOf = (req: ValidRequest): string | undefined => {
  const first = req.messages[0];
  const text = typeof first?.content === "string" ? first.content : first?.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  return /^\[s:([a-z0-9-]{1,32})\]/.exec(text ?? "")?.[1];
};

const withNode = (reply: MockReply, node: string): MockReply =>
  JSON.parse(JSON.stringify(reply).split(NODE_TOKEN).join(node.replace(/\\/g, "\\\\").replace(/"/g, '\\"'))) as MockReply;

/**
 * The scripted `respond` of the mock: the scenario's reply for this turn (the number of assistant turns so far). Without a tag
 * the default script of the slice answers: the first turn writes the root Makefile, later turns answer text.
 */
export function scriptedRespond(scripts: Readonly<Record<string, readonly MockReply[]>>, node: string): (req: ValidRequest) => MockReply {
  return (req) => {
    const tag = tagOf(req);
    const turn = req.messages.filter((m) => m.role === "assistant").length;
    if (tag === undefined) return turn === 0 ? { kind: "tool_use", name: "write_file", input: { path: "Makefile", content: "all:\n" } } : { kind: "text", text: "done" };
    const reply = scripts[tag]?.[turn];
    return reply === undefined ? { kind: "text", text: "done" } : withNode(reply, node);
  };
}

/**
 * Route the adapter's requests to the test's loopback server: only `API_ORIGIN` is served, under the URL that was asked (as the
 * adapter's `redirect: "manual"` check expects); any other URL throws, so no request of the host can reach the network.
 */
function loopbackFetch(port: number): void {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.origin !== API_ORIGIN) throw new Error("slice: the host asked for another origin");
    process.stderr.write(`slice.fetch ${url.pathname}\n`);
    const res = await real(`http://127.0.0.1:${port}${url.pathname}${url.search}`, init);
    return { status: res.status, headers: res.headers, redirected: res.redirected, type: res.type, url: url.href, body: res.body } as unknown as Response;
  }) as typeof fetch;
}

/** The `composer` compose options the slice host passes, or the default script when no file is named. */
export function sliceComposer(env: Readonly<Record<string, string | undefined>>): NonNullable<ComposeOptions["composer"]> {
  const node = realpathSync(process.execPath);
  const file = env["AXIS_SLICE_COMPOSER"];
  if (file === undefined) return { mock: { respond: scriptedRespond({}, node) } };
  const c = JSON.parse(readFileSync(file, "utf8")) as SliceComposerConfig;
  if (c.anthropic !== undefined) loopbackFetch(c.anthropic.port);
  return {
    mock: { respond: scriptedRespond(c.scripts ?? {}, node) },
    ...(c.budget === undefined ? {} : { budget: c.budget }),
    ...(c.workspaceBudget === undefined ? {} : { workspaceBudget: c.workspaceBudget }),
    ...(c.maxTurns === undefined ? {} : { maxTurns: c.maxTurns }),
    ...(c.toolCaps === undefined ? {} : { toolCaps: c.toolCaps }),
    ...(c.anthropic === undefined ? {} : { anthropic: { connectionId: c.anthropic.connectionId, backend: fakeBackend(c.anthropic.connectionId, c.anthropic.key) } }),
  };
}
