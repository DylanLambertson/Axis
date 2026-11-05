// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import diagnostics from "node:diagnostics_channel";
import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach } from "node:test";
import { inspect } from "node:util";
import type { StreamEvent } from "../src/types.js";
import type { SuiteRuntime } from "./runtime.js";

export function registerHooks(rt: SuiteRuntime): void {
  const { needles, bypasses, channelHandlers, takeViolations, lateWindow, offOrigin } = rt;
  beforeEach(() => {
    rt.outputs = [];
    rt.fixtures = [];
    // Any use of the global fetch during a test bypasses the transport (N-2).
    rt.savedFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : String((input as { url?: unknown })?.url ?? input);
      bypasses.push(`globalThis.fetch: ${url.split(/[?#]/)[0] ?? ""}`);
      throw new TypeError("contract suite: globalThis.fetch bypasses the adapter's transport");
    }) as typeof globalThis.fetch;
  });

  // Late requests and bypasses, from this test or an earlier one (SF-1, N-2).
  afterEach(() => {
    if (rt.savedFetch !== undefined) globalThis.fetch = rt.savedFetch;
    rt.savedFetch = undefined;
    assert.deepEqual(takeViolations(), [], "a request reached the redirect host, left the origin or bypassed the transport");
  });

  before(() => {
    for (const [name, fn] of channelHandlers) diagnostics.subscribe(name, fn);
  });

  // One wait for the whole suite: a request made after its check concluded,
  // up to LATE_REQUEST_WINDOW_MS after the last test, still fails the file.
  after(async () => {
    await lateWindow();
    for (const [name, fn] of channelHandlers) diagnostics.unsubscribe(name, fn);
    assert.deepEqual(takeViolations(), [], "a late request reached the redirect host, left the origin or bypassed the transport");
  });

  // In every scenario: every request the transport saw stayed on the
  // adapter's origin (none at all without one), and none asked fetch to
  // follow redirects, which it does by default (ANT-1).
  afterEach(() => {
    for (const tr of rt.fixtures) {
      const off = offOrigin(tr);
      assert.deepEqual(off.map((r) => r.url.split(/[?#]/)[0]), [], "a request left the adapter's origin");
      for (const r of tr.requests) {
        assert.ok(r.redirect === "manual" || r.redirect === "error", `a request did not set redirect to manual or error (${String(r.redirect)})`);
      }
      // An adapter with an origin reaches the provider only through the
      // transport: at least one recorded request per provider request (N-2).
      if (tr.origin !== undefined && tr.fixture !== undefined) {
        assert.ok(tr.requests.length >= tr.fixture.requestCount(), `${tr.fixture.requestCount()} provider requests but ${tr.requests.length} through the transport`);
      }
    }
  });

  // Every output of every scenario, events and results included, is free of
  // the provider body canary and of the credential, whole or in part (NS5).
  afterEach(() => {
    // Deltas are also checked joined: a credential split across chunks is
    // still a credential in what the consumer assembles.
    const joined = rt.outputs
      .map((o) => {
        const ev = o as Partial<StreamEvent> & { delta?: { text?: unknown; partialJson?: unknown } };
        if (ev?.type !== "content_block_delta") return "";
        return typeof ev.delta?.text === "string" ? ev.delta.text : typeof ev.delta?.partialJson === "string" ? ev.delta.partialJson : "";
      })
      .join("");
    for (const n of needles) assert.ok(!joined.includes(n), "streamed output contains the credential or the provider body");
    for (const o of rt.outputs) {
      const text = o instanceof Error || (typeof o === "object" && o !== null && !Array.isArray(o) && Object.getPrototypeOf(o) !== Object.prototype)
        ? inspect(o, { depth: Infinity, showHidden: true, getters: true })
        : JSON.stringify(o) ?? "";
      for (const n of needles) assert.ok(!text.includes(n), "an adapter output contains the credential or the provider body");
    }
  });
}
