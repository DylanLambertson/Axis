// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { FetchLike, SecretBackend } from "../src/bindings/providers.js";

/**
 * A local mock of the Anthropic HTTP API for the C6 tests: a real `node:http` server on 127.0.0.1 and Node's real `fetch`,
 * so status codes, headers, redirects (`redirect: "manual"`) and streamed bodies are the real ones. No test reaches the
 * network. The adapter only ever builds URLs on its fixed origin; the test `fetch` sends those to this server and reports
 * the response under the URL that was asked for (the adapter refuses a response whose URL differs, as a followed
 * redirect would). Every URL the adapter asked for is recorded, so a request to any other host is visible.
 */

export const ORIGIN = "https://api.anthropic.com";
export const MODEL = "claude-test-1";

/** What `POST /v1/messages` answers. */
export type MessagesReply =
  | { readonly kind: "text"; readonly text: string; readonly model?: string; readonly inputTokens?: number; readonly outputTokens?: number }
  | { readonly kind: "tool"; readonly name: string; readonly input: unknown }
  | { readonly kind: "error"; readonly status: number; readonly body: string; readonly headers?: Record<string, string> }
  | { readonly kind: "redirect"; readonly location: string }
  /** A valid SSE stream of text deltas of `chunk` characters, about `bytes` long, unless the client goes first. */
  | { readonly kind: "flood"; readonly bytes: number; readonly chunk: number }
  /** Headers and nothing else, ever. */
  | { readonly kind: "hang" };

export interface Seen {
  readonly method: string;
  readonly path: string;
  /** The `x-api-key` header as the server received it. */
  readonly key: string | undefined;
  readonly body: string;
}

export interface MockAnthropic {
  readonly fetch: FetchLike;
  /** Every URL the adapter asked `fetch` for, in order. */
  readonly asked: string[];
  readonly seen: Seen[];
  /** Replies of `POST /v1/messages`, in order; the last repeats. */
  replies: MessagesReply[];
  /** Bytes the server wrote on message streams. */
  streamed(): number;
  close(): Promise<void>;
}

const sse = (type: string, data: unknown): string => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;

function textStream(text: string, model: string, inputTokens: number, outputTokens: number): string {
  let out = sse("message_start", { type: "message_start", message: { id: "msg_c6", type: "message", role: "assistant", model, content: [], usage: { input_tokens: inputTokens, output_tokens: 1 } } });
  out += sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  for (let i = 0; i < text.length; i += 7) out += sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: text.slice(i, i + 7) } });
  out += sse("content_block_stop", { type: "content_block_stop", index: 0 });
  out += sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: outputTokens } });
  return out + sse("message_stop", { type: "message_stop" });
}

function toolStream(name: string, input: unknown, model: string): string {
  const json = JSON.stringify(input);
  let out = sse("message_start", { type: "message_start", message: { id: "msg_c6t", type: "message", role: "assistant", model, content: [], usage: { input_tokens: 30, output_tokens: 1 } } });
  out += sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_c6_1", name, input: {} } });
  for (let i = 0; i < json.length; i += 9) out += sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: json.slice(i, i + 9) } });
  out += sse("content_block_stop", { type: "content_block_stop", index: 0 });
  out += sse("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 20 } });
  return out + sse("message_stop", { type: "message_stop" });
}

const modelInfo = { type: "model", id: MODEL, display_name: "Claude Test", max_input_tokens: 200_000, max_tokens: 64_000, capabilities: { image_input: { supported: false } } };

export async function mockAnthropic(): Promise<MockAnthropic> {
  const asked: string[] = [];
  const seen: Seen[] = [];
  let streamed = 0;
  let next = 0;
  const open = new Set<ServerResponse>();
  const state = { replies: [{ kind: "text", text: "done" }] as MessagesReply[] };

  const json = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const handle = (req: IncomingMessage, res: ServerResponse, body: string): void => {
    const url = new URL(req.url ?? "/", "http://mock");
    const key = req.headers["x-api-key"];
    seen.push({ method: req.method ?? "", path: url.pathname, key: typeof key === "string" ? key : undefined, body });
    if (req.method === "GET" && url.pathname === "/v1/models") return json(res, 200, { data: [{ type: "model", id: MODEL, display_name: "Claude Test" }], has_more: false, first_id: MODEL, last_id: MODEL });
    if (req.method === "GET" && url.pathname === `/v1/models/${MODEL}`) return json(res, 200, modelInfo);
    if (req.method !== "POST" || url.pathname !== "/v1/messages") return json(res, 404, { type: "error", error: { type: "not_found_error", message: "no" } });
    const reply = state.replies[Math.min(next++, state.replies.length - 1)] ?? { kind: "hang" };
    const asked = (JSON.parse(body) as { model: string }).model;
    switch (reply.kind) {
      case "text":
      case "tool": {
        const text = reply.kind === "text" ? textStream(reply.text, reply.model ?? asked, reply.inputTokens ?? 25, reply.outputTokens ?? 5) : toolStream(reply.name, reply.input, asked);
        res.writeHead(200, { "content-type": "text/event-stream" });
        streamed += Buffer.byteLength(text);
        return void res.end(text);
      }
      case "error":
        res.writeHead(reply.status, { "content-type": "application/json", ...reply.headers });
        return void res.end(reply.body);
      case "redirect":
        res.writeHead(302, { location: reply.location });
        return void res.end();
      case "hang":
        res.writeHead(200, { "content-type": "text/event-stream" });
        return void res.flushHeaders();
      case "flood": {
        res.writeHead(200, { "content-type": "text/event-stream" });
        let sent = Buffer.byteLength(sse("message_start", { type: "message_start", message: { id: "msg_f", model: asked, usage: { input_tokens: 5, output_tokens: 1 } } }));
        res.write(sse("message_start", { type: "message_start", message: { id: "msg_f", model: asked, usage: { input_tokens: 5, output_tokens: 1 } } }));
        res.write(sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
        const delta = sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x".repeat(reply.chunk) } });
        const pump = (): void => {
          while (sent < reply.bytes && !res.destroyed) {
            sent += delta.length;
            streamed += delta.length;
            if (!res.write(delta)) return void res.once("drain", pump);
          }
          // A complete, valid stream: only its size is wrong.
          res.write(sse("content_block_stop", { type: "content_block_stop", index: 0 }));
          res.write(sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } }));
          res.end(sse("message_stop", { type: "message_stop" }));
        };
        return pump();
      }
    }
  };

  const server = createServer((req, res) => {
    open.add(res);
    res.on("close", () => open.delete(res));
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => handle(req, res, Buffer.concat(chunks).toString("utf8")));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  const fetchLike: FetchLike = async (url, init) => {
    asked.push(url);
    const u = new URL(url);
    if (u.origin !== ORIGIN) throw new Error("the adapter asked for another host");
    const res = await fetch(`http://127.0.0.1:${port}${u.pathname}${u.search}`, init);
    return { status: res.status, headers: res.headers, redirected: res.redirected, type: res.type, url, body: res.body };
  };

  return {
    fetch: fetchLike,
    asked,
    seen,
    get replies() {
      return state.replies;
    },
    set replies(r: MessagesReply[]) {
      state.replies = r;
      next = 0;
    },
    streamed: () => streamed,
    async close() {
      for (const res of open) res.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** A key-shaped credential built at run time (no literal that looks like a key in the repository). */
export const testKey = (n = 1): string => ["sk", "ant", "api03", `c6holdout${n}`.padEnd(24, "q")].join("-");
/** A credential no built-in redaction rule knows: only its registration with the host redactor can hide it. */
export const plainKey = (): string => ["holdout", "standin", "credential", "c6"].join("~");

export interface FakeBackend extends SecretBackend {
  /** How many times the key was read. */
  readonly reads: () => number;
  /** Make every call fail, as a locked keyring does. */
  lock(locked: boolean): void;
  setKey(key: string | undefined): void;
}

/** A vault backend with one key stored on an OS-protected keyring (or a weak one), in memory. */
export function fakeBackend(connectionId: string, key: string | undefined, info: { readonly id: "gnome_libsecret" | "basic_text"; readonly protection: "os_protected" | "none" } = { id: "gnome_libsecret", protection: "os_protected" }): FakeBackend {
  let reads = 0;
  let locked = false;
  let current = key;
  const meta = { storedAt: 1, backend: info.id, protection: info.protection, weakConsent: info.protection === "none" };
  const check = (): void => {
    if (locked) throw new Error(`keyring locked ${current ?? ""}`);
  };
  return {
    reads: () => reads,
    lock: (l) => void (locked = l),
    setKey: (k) => void (current = k),
    info: async () => (check(), { id: info.id, protection: info.protection, label: "Test keyring" }),
    put: async () => {
      throw new Error("not in these tests");
    },
    get: async (name) => {
      check();
      reads++;
      return name === connectionId && current !== undefined ? { secret: current, meta } : undefined;
    },
    meta: async (name) => (check(), name === connectionId && current !== undefined ? meta : undefined),
    remove: async () => false,
    list: async () => (check(), current === undefined ? [] : [{ name: connectionId, meta }]),
  };
}
