// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_STRING_CHARS, Redactor } from "@axis/audit";
import { MAX_PROMPT_CHARS } from "@axis/protocol";
import { ProviderError, SCAN_BUDGET_CHARS, YIELD_CHARS, createMockProvider, createRunBudget, guardProvider, type ScanContext } from "@axis/providers";
import { canary } from "../testing/git-fixture.js";
import { DEFAULT_MAX_OUTPUT_TOKENS, DEFAULT_MAX_TURNS, DEFAULT_TOOL_CAPS, runComposerLoop } from "../src/composer/loop.js";
import { WINDOW_STEP, YIELD_WINDOWS, assertScanBudgetFits, providerRedactor, scanCharsAtCaps, windowBounds, windowCount } from "../src/bindings/provider-redactor.js";

// C7-F3: the host hook's asynchronous outgoing scan (docs/design/composer-outgoing-scan.md): the same answers and kept verdicts
// as the synchronous one, yielding between windows, charged to the request's budget, stopped by its signal.

const prose = (chars: number): string => {
  const line = "The build step printed one more ordinary line of output.\n";
  return line.repeat(Math.ceil(chars / line.length)).slice(0, chars);
};
const ctx = (remaining = SCAN_BUDGET_CHARS, signal: AbortSignal = new AbortController().signal): ScanContext => ({ signal, budget: { remaining } });
const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof ProviderError, String(e));
    return e.code;
  }
  return "resolved";
};

/** Counts window reads; `onCall(n)` runs before the n-th read (1-based). */
class Counting extends Redactor {
  calls = 0;
  onCall: (n: number) => void = () => undefined;
  override redactString(input: string): string {
    this.calls += 1;
    this.onCall(this.calls);
    return super.redactString(input);
  }
}

/** A string of `windows` windows (not a multiple of YIELD_WINDOWS unless asked) of clean prose. */
const ofWindows = (windows: number): string => prose(MAX_STRING_CHARS + (windows - 1) * WINDOW_STEP - 100);

test("the asynchronous scan answers as the synchronous one: clean, a pattern, a registered key, a lone surrogate, short strings", async () => {
  const key = "registered-credential-value-0042";
  const cases = [prose(40 * 1024), `${prose(30_000)} ${canary(41)} ${prose(9_000)}`, `${prose(20_000)}${key}${prose(30_000)}`, `${prose(30_000)}\ud800${prose(30)}`, "short and clean", `short ${canary(41)} `, `${key} short`];
  for (const text of cases) {
    const a = new Redactor();
    a.registerSecret(key);
    const b = new Redactor();
    b.registerSecret(key);
    assert.equal(await providerRedactor(a).containsSecretAsync?.(text, ctx()), providerRedactor(b).containsSecret(text), text.slice(0, 40));
  }
});

test("a text with a lone surrogate never takes the clean verdict of its replacement-character twin on the asynchronous path", async () => {
  const p = providerRedactor(new Redactor());
  const body = prose(40_000);
  assert.equal(await p.containsSecretAsync?.(`${body}�`, ctx()), false);
  assert.equal(await p.containsSecretAsync?.(`${body}\ud800`, ctx()), true);
});

test("a long scan yields: a callback queued before it runs before it ends, and it reads windowCount windows", async () => {
  const r = new Counting();
  const p = providerRedactor(r);
  const big = prose(4 * 1024 * 1024);
  let ranAt = -1;
  setImmediate(() => (ranAt = r.calls));
  assert.equal(await p.containsSecretAsync?.(big, ctx()), false);
  assert.equal(r.calls, windowCount(big.length));
  assert.ok(ranAt >= 1 && ranAt <= YIELD_WINDOWS, `the queued callback ran after ${ranAt} windows`);
});

test("budget: every window read is charged, a kept verdict and a short string cost nothing, a stop keeps no verdict", async () => {
  const r = new Counting();
  const p = providerRedactor(r);
  const text = ofWindows(11);
  const c = ctx();
  assert.equal(await p.containsSecretAsync?.(text, c), false);
  const charged = [...windowBounds(text)].reduce((n, [s, e]) => n + e - s, 0);
  assert.equal(SCAN_BUDGET_CHARS - c.budget.remaining, charged);
  await p.containsSecretAsync?.(text, c);
  await p.containsSecretAsync?.("short", c);
  assert.equal(SCAN_BUDGET_CHARS - c.budget.remaining, charged, "a kept verdict and a short string are free");

  const fresh = ofWindows(13);
  r.calls = 0;
  assert.equal(await code(p.containsSecretAsync?.(fresh, ctx(3 * MAX_STRING_CHARS)) ?? Promise.resolve()), "scan_budget");
  assert.ok(r.calls <= 3, "no window is read past the budget");
  r.calls = 0;
  assert.equal(await p.containsSecretAsync?.(fresh, ctx()), false);
  assert.equal(r.calls, windowCount(fresh.length), "nothing was kept from the stopped scan");
});

test("aborts: before the scan, between windows and after the last one each end cancelled and keep no verdict", async () => {
  const text = ofWindows(11);
  assert.notEqual(windowCount(text.length) % YIELD_WINDOWS, 0, "the last window is not followed by a yield");
  for (const when of ["before", "between", "after"] as const) {
    const r = new Counting();
    const p = providerRedactor(r);
    const ac = new AbortController();
    if (when === "before") ac.abort();
    if (when === "between") setImmediate(() => ac.abort());
    if (when === "after") r.onCall = (n) => n === windowCount(text.length) && ac.abort();
    assert.equal(await code(p.containsSecretAsync?.(text, ctx(SCAN_BUDGET_CHARS, ac.signal)) ?? Promise.resolve()), "cancelled", when);
    if (when === "before") assert.equal(r.calls, 0);
    if (when === "between") assert.ok(r.calls < windowCount(text.length));
    r.onCall = () => undefined;
    r.calls = 0;
    assert.equal(await p.containsSecretAsync?.(text, ctx()), false);
    assert.equal(r.calls, windowCount(text.length), `${when}: scanned in full again`);
  }
});

test("a key registered during a string's scan keeps no verdict for it and moves secretsVersion (the guard rescans)", async () => {
  const r = new Counting();
  const p = providerRedactor(r);
  const text = ofWindows(11);
  const n = windowCount(text.length);
  const before = p.secretsVersion?.();
  r.onCall = (i) => i === 2 && r.registerSecret("registered-credential-value-mid-abcdef");
  assert.equal(await p.containsSecretAsync?.(text, ctx()), false);
  assert.notEqual(p.secretsVersion?.(), before);
  r.onCall = () => undefined;
  r.calls = 0;
  assert.equal(await p.containsSecretAsync?.(text, ctx()), false);
  assert.equal(r.calls, n, "nothing was kept from the scan the registration crossed");
});

/** A guarded mock over the real host hook, and what it was sent. */
function guarded(r: Redactor) {
  const mock = createMockProvider({ replies: [{ kind: "text", text: "ok" }] });
  return { mock, g: guardProvider(mock, { redactor: providerRedactor(r) }) };
}
const ask = (...texts: string[]) => ({
  model: "mock-model",
  messages: texts.map((text, i) => ({ role: i % 2 === 0 ? ("user" as const) : ("assistant" as const), content: [{ type: "text" as const, text }] })),
  maxOutputTokens: 100,
});
const refusal = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "sent";
  } catch (e) {
    return e instanceof ProviderError ? e.code : String(e);
  }
};

test("a key registered while a LATER string is scanned is found in a string judged before it: the whole request is rescanned (review c7-f3-impl r1 SF-1)", async () => {
  const key = "late-registered-credential-value-0001";
  const holder = `${prose(2_000)} ${key} ${prose(2_000)}`;
  const r = new Counting();
  let long = 0;
  let holderBefore = false;
  const base = r.redactString.bind(r);
  r.redactString = (w: string) => {
    if (w === holder && long === 0) holderBefore = true;
    if (w.length > 10_000 && ++long === 30) r.registerSecret(key);
    return base(w);
  };
  const { mock, g } = guarded(r);
  assert.equal(await refusal(g.generate(ask(prose(400_000), "ok", holder), { runId: "r", signal: new AbortController().signal })), "secret_in_request");
  assert.equal(holderBefore, true, "the string holding the key was judged clean before the key was registered");
  assert.equal(mock.requests.length, 0, "nothing was sent");
});

test("one registration during a request costs one more scan of the request, and the verdicts are kept under the new count", async () => {
  const r = new Counting();
  const text = ofWindows(11);
  const n = windowCount(text.length);
  let long = 0;
  const base = r.redactString.bind(r);
  r.redactString = (w: string) => {
    if (w.length > 10_000 && ++long === 2) r.registerSecret("registered-credential-value-once-abcdef");
    return base(w);
  };
  const { mock, g } = guarded(r);
  await g.generate(ask(text), { runId: "r", signal: new AbortController().signal });
  assert.equal(long, 2 * n);
  assert.equal(mock.requests.length, 1);
  long = 0;
  await g.generate(ask(text), { runId: "r", signal: new AbortController().signal });
  assert.equal(long, 0, "the second scan's verdict is kept under the new count");
});

test("a request of many one-window strings yields between them: no more than YIELD_CHARS plus one string is read per loop turn (review c7-f3-impl r1 SF-2)", async () => {
  const r = new Counting();
  let since = 0;
  let most = 0;
  let scanning = true;
  const tick = (): void => {
    since = 0;
    if (scanning) setImmediate(tick);
  };
  setImmediate(tick);
  const base = r.redactString.bind(r);
  r.redactString = (w: string) => {
    since += w.length;
    most = Math.max(most, since);
    return base(w);
  };
  const { mock, g } = guarded(r);
  const texts = Array.from({ length: 100 }, (_, i) => `${i} ${prose(16_000)}`);
  await g.generate(ask(...texts), { runId: "r", signal: new AbortController().signal });
  scanning = false;
  assert.equal(mock.requests.length, 1);
  assert.ok(most <= YIELD_CHARS + MAX_STRING_CHARS, `${most} characters read in one loop turn`);
});

test("two concurrent scans of one string both answer clean, and one verdict is kept", async () => {
  const r = new Counting();
  const p = providerRedactor(r);
  const text = ofWindows(19);
  assert.deepEqual(await Promise.all([p.containsSecretAsync?.(text, ctx()), p.containsSecretAsync?.(text, ctx())]), [false, false]);
  r.calls = 0;
  assert.equal(await p.containsSecretAsync?.(text, ctx()), false);
  assert.equal(r.calls, 0);
});

test("the request budget holds a whole run history at the default caps scanned twice, with the windows' rounding; raised caps are refused (review c7-f3-impl r1 N2)", () => {
  const caps = { ...DEFAULT_TOOL_CAPS, maxTurns: DEFAULT_MAX_TURNS, maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS, promptChars: MAX_PROMPT_CHARS };
  // Characters: UTF-8 bytes bound the tool inputs and results; model text is at most 4,096 output tokens a turn, taken at a
  // generous 16 characters a token; the prompt.
  const history = caps.inputBytesPerRun + caps.resultBytesPerRun + caps.maxTurns * caps.maxOutputTokens * 16 + caps.promptChars;
  const long = MAX_STRING_CHARS + 1;
  const longStrings = Math.ceil(caps.inputBytesPerRun / long) + Math.ceil(caps.resultBytesPerRun / long) + caps.maxTurns + 1;
  // windowCount(L) <= (L - SCAN) / STEP + 2 for each long string, so a history reads at most this many characters once.
  const once = Math.ceil((history / WINDOW_STEP) * MAX_STRING_CHARS) + 2 * longStrings * MAX_STRING_CHARS;
  assert.equal(scanCharsAtCaps(caps), 2 * once);
  assert.ok(SCAN_BUDGET_CHARS >= 2 * once, `${SCAN_BUDGET_CHARS} < 2 x ${once}`);
  assert.doesNotThrow(() => assertScanBudgetFits(caps));
  assert.throws(() => assertScanBudgetFits({ ...caps, inputBytesPerRun: 4 * caps.inputBytesPerRun }), RangeError);
  assert.throws(() => assertScanBudgetFits({ ...caps, maxTurns: 10 * caps.maxTurns }), RangeError);
});

test("a request the hook refuses scan_budget never reaches the provider, and the run ends FAILED PROVIDER_SCAN_BUDGET", async () => {
  // The real host hook in the guard: a key registered during the scan of the long prompt, and another during the scan again.
  const r = new Counting();
  let long = 0;
  const base = r.redactString.bind(r);
  r.redactString = (w: string) => {
    if (w.length > 1000 && (++long === 2 || long === windowCount(prompt.length) + 2)) r.registerSecret(`registered-credential-value-${long}-abcdef`);
    return base(w);
  };
  const prompt = prose(MAX_PROMPT_CHARS - 10);
  const mock = createMockProvider({ replies: [{ kind: "text", text: "never" }] });
  const end = await runComposerLoop({
    runId: "r1", mode: "ask", prompt, model: "mock-model", budget: createRunBudget({}), signal: new AbortController().signal, emit: () => undefined,
    destination: { providerId: "mock", connectionId: "mock-connection", modelId: "mock-model", text: "Local" },
    tools: undefined, provider: guardProvider(mock, { redactor: providerRedactor(r) }),
  });
  assert.deepEqual(end, { state: "FAILED", reason: "PROVIDER_SCAN_BUDGET" });
  assert.equal(mock.requests.length, 0);
});
