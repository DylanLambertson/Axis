// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { Redactor, type AuditEventInput, type AuditSink } from "@axis/audit";
import { ERROR_CODES } from "@axis/protocol";
import { BrokerError, ToolBroker, createCommandRunner, nodeBrokerFs, type ApprovalHook, type ApprovalRequest, type BrokerDeps, type ToolDefinition } from "../src/index.js";
import { makeWorld } from "./helpers.js";

const worlds: Array<{ cleanup(): void }> = [];
after(() => worlds.forEach((w) => w.cleanup()));

interface Rig {
  broker: ToolBroker;
  events: AuditEventInput[];
  requests: ApprovalRequest[];
  w: ReturnType<typeof makeWorld>;
}
const sink = (events: AuditEventInput[]): AuditSink => ({ append: (i) => { events.push(i); return {} as never; } });
const user = (r: ApprovalRequest, o: object = {}) => ({ approved: true, approvedBy: "user", approvalId: `id-${Math.random().toString(36).slice(2, 12)}`, digest: r.digest, expiresAt: Date.now() + 30_000, ...o });

function rig(o: { approve?: (r: ApprovalRequest) => unknown; sink?: AuditSink; deps?: Partial<BrokerDeps>; env?: (w: ReturnType<typeof makeWorld>) => Record<string, string> } = {}): Rig {
  const w = makeWorld();
  worlds.push(w);
  const events: AuditEventInput[] = [];
  const requests: ApprovalRequest[] = [];
  const approval: ApprovalHook | undefined = o.approve === undefined ? undefined : { request: async (r) => { requests.push(r); return o.approve?.(r); } };
  const broker = new ToolBroker({
    registry: w.registry, fs: nodeBrokerFs, audit: o.sink ?? sink(events), runner: createCommandRunner({ killGraceMs: 200 }),
    parentEnv: () => ({ PATH: process.env["PATH"] ?? "", HOME: w.base, ...(o.env?.(w) ?? {}) }),
    ...(approval === undefined ? {} : { approval }), ...o.deps,
  });
  broker.register({
    name: "read_file", tier: "read", args: z.strictObject({ path: z.string() }),
    targets: (a) => [{ path: a.path, access: "read" }],
    run: async (ctx, a) => (await ctx.readFile(a.path, 1000)).toString(),
  });
  broker.register({
    name: "write_file", tier: "write", args: z.strictObject({ path: z.string(), content: z.string() }),
    targets: (a) => [{ path: a.path, access: "write" }],
    run: async (ctx, a) => { await ctx.writeFile(a.path, Buffer.from(a.content), { mode: "upsert", maxBytes: 1000 }); return "written"; },
  });
  broker.register({
    name: "run", tier: "network", args: z.strictObject({ command: z.string(), args: z.array(z.string()).max(20) }),
    command: (a) => a.command, envAdditions: ["CANARY_PLAIN"],
    run: async (ctx, a) => ctx.run({ command: a.command, args: a.args, timeoutMs: 5000, maxOutputBytes: 10_000 }),
  });
  return { broker, events, requests, w };
}
const call = (tool: string, args: unknown, extra: object = {}) => ({ tool, worktreeId: "wt1", actor: "agent:composer-1", args, ...extra });
const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof BrokerError);
    return `${e.code}/${e.reason}`;
  }
  return "no-error";
};

test("read and write run without approval and are audited before and after", async () => {
  const r = rig();
  assert.equal(await r.broker.invoke(call("write_file", { path: "a.txt", content: "hi" })), "written");
  assert.equal(await r.broker.invoke(call("read_file", { path: "a.txt" })), "hi");
  assert.deepEqual(r.events.map((e) => e.action), ["broker.decision", "broker.result", "broker.decision", "broker.result"]);
  assert.equal(r.events[0]?.actor, "agent:composer-1");
  assert.equal((r.events[1]?.payload as { bytesWritten: number }).bytesWritten, 2);
});

test("unknown tools, bad arguments and bad calls deny and are audited", async () => {
  const r = rig();
  for (const t of ["nope", "__proto__", "constructor", "", "READ_FILE"]) assert.equal(await codeOf(r.broker.invoke(call(t, {}))), "E_POLICY_DENIED/unknown-tool", t);
  assert.equal(await codeOf(r.broker.invoke(call("read_file", { path: "a", extra: 1 }))), "E_INVALID_ARGUMENT/invalid-args");
  assert.equal(await codeOf(r.broker.invoke(call("read_file", null))), "E_INVALID_ARGUMENT/invalid-args");
  assert.equal(await codeOf(r.broker.invoke({ ...call("read_file", { path: "a" }), actor: "root" })), "E_INVALID_ARGUMENT/invalid-call");
  assert.equal(await codeOf(r.broker.invoke({ ...call("read_file", { path: "a" }), worktreeId: "../x" })), "E_INVALID_ARGUMENT/invalid-call");
  assert.equal(await codeOf(r.broker.invoke(null as never)), "E_INVALID_ARGUMENT/invalid-call");
  assert.ok(r.events.length >= 7 && r.events.every((e) => e.outcome === "denied" || e.actor !== "agent:composer-1"));
});

test("containment failures come from the tool path and deny before any approval", async () => {
  const r = rig({ approve: () => { throw new Error("must not be asked"); } });
  assert.equal(await codeOf(r.broker.invoke(call("read_file", { path: "../outside/secret.txt" }))), "E_POLICY_DENIED/dotdot");
  assert.equal(await codeOf(r.broker.invoke(call("write_file", { path: "/etc/x", content: "" }))), "E_POLICY_DENIED/outside-root");
  assert.equal(r.requests.length, 0);
});

test("a protected write needs approval, whatever the tier; no hook means denied", async () => {
  const none = rig();
  mkdirSync(join(none.w.wt, ".github", "workflows"), { recursive: true });
  assert.equal(await codeOf(none.broker.invoke(call("write_file", { path: ".github/workflows/ci.yml", content: "x" }))), "E_POLICY_DENIED/no-approval-hook");
  assert.equal(existsSync(join(none.w.wt, ".github", "workflows", "ci.yml")), false, "nothing was written");
  const r = rig({ approve: (q) => user(q) });
  mkdirSync(join(r.w.wt, ".husky"));
  mkdirSync(join(r.w.wt, ".github", "workflows"), { recursive: true });
  mkdirSync(join(r.w.wt, ".vscode"));
  for (const p of [".github/workflows/ci.yml", ".husky/pre-commit", ".vscode/tasks.json", "lefthook.yml", ".pre-commit-config.yaml"]) {
    assert.equal(await r.broker.invoke(call("write_file", { path: p, content: "x" })), "written", p);
  }
  assert.equal(r.requests.length, 5);
  assert.ok(r.requests[0]?.reasons.includes("protected:.github"));
  const approved = r.events.find((e) => (e.payload as { decision?: string }).decision === "approved");
  const p = approved?.payload as { approvedBy: string; approvalId: string; expiresAt: number };
  assert.equal(p.approvedBy, "user");
  assert.ok(p.approvalId && p.expiresAt > Date.now(), "audit carries approver identity and expiry");
  assert.equal(await r.broker.invoke(call("write_file", { path: "plain.txt", content: "x" })), "written");
  assert.equal(r.requests.length, 5, "an ordinary write is not asked about");
  // Git directory paths gate reads too.
  mkdirSync(join(r.w.wt, ".git"));
  writeFileSync(join(r.w.wt, ".git", "config"), "[core]");
  const before = r.requests.length;
  await r.broker.invoke(call("read_file", { path: ".git/config" }));
  assert.equal(r.requests.length, before + 1);
});

test("approvals: an agent approver, a different digest, a replay, a decline, a throw and a hang all deny", async () => {
  const cases: Array<[string, (q: ApprovalRequest) => unknown, string]> = [
    ["agent", (q) => user(q, { approvedBy: "agent:composer-1" }), "bad-approver"],
    ["digest", (q) => user(q, { digest: "0".repeat(64) }), "approval-mismatch"],
    ["decline", () => ({ approved: false }), "approval-declined"],
    ["throw", () => { throw new Error("boom /secret/path"); }, "approval-error"],
    ["garbage", () => "yes", "approval-malformed"],
    ["expired", (q) => user(q, { expiresAt: Date.now() - 1 }), "approval-expired"],
  ];
  for (const [name, hook, why] of cases) {
    const r = rig({ approve: hook });
    mkdirSync(join(r.w.wt, ".husky"));
    assert.equal(await codeOf(r.broker.invoke(call("write_file", { path: ".husky/x", content: "1" }))), `E_POLICY_DENIED/${why}`, name);
    assert.equal(existsSync(join(r.w.wt, ".husky", "x")), false);
  }
  const fixed = "fixed-approval-id";
  const r = rig({ approve: (q) => user(q, { approvalId: fixed }) });
  mkdirSync(join(r.w.wt, ".husky"));
  assert.equal(await r.broker.invoke(call("write_file", { path: ".husky/a", content: "1" })), "written");
  assert.equal(await codeOf(r.broker.invoke(call("write_file", { path: ".husky/a", content: "1" }))), "E_POLICY_DENIED/approval-replayed");
  const slow = rig({ approve: () => new Promise(() => undefined), deps: { approvalTimeoutMs: 100 } });
  mkdirSync(join(slow.w.wt, ".husky"));
  assert.equal(await codeOf(slow.broker.invoke(call("write_file", { path: ".husky/a", content: "1" }))), "E_TIMEOUT/approval-timeout");
  assert.equal(process.getActiveResourcesInfo().filter((x) => x === "Timeout").length, 0, "the approval timer was cleared");
  const bad = rig({ approve: (q) => user(q), deps: { approvalTimeoutMs: NaN } });
  mkdirSync(join(bad.w.wt, ".husky"));
  assert.equal(await codeOf(bad.broker.invoke(call("write_file", { path: ".husky/a", content: "1" }))), "E_POLICY_DENIED/approval-error");
});

test("a tool with an invalid tier is refused at registration; a NaN floor at construction", () => {
  const r = rig();
  const def = (tier: unknown): ToolDefinition => ({ name: "t1", tier: tier as never, args: z.object({}), run: async () => 1 });
  for (const t of [NaN, 3, "bogus", undefined, "__proto__"]) assert.throws(() => r.broker.register(def(t)), BrokerError, String(t));
  assert.throws(() => r.broker.register({ ...def("read"), name: "Bad Name" }), BrokerError);
  assert.throws(() => r.broker.register({ ...def("read"), name: "read_file" }), BrokerError, "duplicates");
  assert.throws(() => rig({ deps: { policy: { approvalFloor: NaN } } }), BrokerError);
});

test("commands: network tier asks; a launcher is asked about too; the child gets only the allow-listed environment", async () => {
  const canary = "canary-secret-value-123";
  const r = rig({ approve: (q) => user(q), env: () => ({ GITHUB_TOKEN: canary, SSH_AUTH_SOCK: "/s", VSCODE_NONCE: "n", CANARY_PLAIN: "plain-ok", AWS_SECRET_ACCESS_KEY: canary }) });
  const out = (await r.broker.invoke(call("run", { command: process.execPath, args: ["-e", "process.stdout.write(JSON.stringify(process.env))"] }))) as { stdout: Buffer; endedBy: string };
  const env = JSON.parse(out.stdout.toString()) as Record<string, string>;
  assert.deepEqual(Object.keys(env).sort(), ["CANARY_PLAIN", "HOME", "PATH"].sort());
  assert.equal(r.requests.length, 1);
  await r.broker.invoke(call("run", { command: "/bin/sh", args: ["-c", "true"] }));
  assert.equal(r.requests[1]?.tier, "privileged");
  assert.ok(r.requests[1]?.reasons.includes("launcher"));
  assert.equal(await codeOf(r.broker.invoke(call("run", { command: "definitely-not-a-command-axis", args: [] }))), "E_NOT_FOUND/unresolved-command");
  assert.equal(JSON.stringify(r.events).includes(canary), false);
});

test("a planted executable in the worktree is not run for a bare command name", async () => {
  const r = rig({ approve: (q) => user(q), env: (w) => ({ PATH: `${join(w.wt, "node_modules", ".bin")}:${process.env["PATH"] ?? ""}` }) });
  const bin = join(r.w.wt, "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  const marker = join(r.w.wt, "PLANTED");
  writeFileSync(join(bin, "tool-axis-test"), `#!/bin/sh\necho x > ${marker}\n`, { mode: 0o755 });
  assert.equal(await codeOf(r.broker.invoke(call("run", { command: "tool-axis-test", args: [] }))), "E_NOT_FOUND/unresolved-command");
  assert.equal(existsSync(marker), false);
  // An absolute path (or a symlink to one) into the worktree is refused too.
  assert.equal(await codeOf(r.broker.invoke(call("run", { command: join(bin, "tool-axis-test"), args: [] }))), "E_POLICY_DENIED/unresolved-command");
  assert.equal(existsSync(marker), false);
});

test("audit: redacted before the sink, canaries never stored, a failing or async sink stops the call", async () => {
  const redactor = new Redactor();
  redactor.registerSecret("vault-registered-secret-42");
  const r = rig({ deps: { redactor } });
  writeFileSync(join(r.w.wt, "note.txt"), "x");
  await r.broker.invoke(call("read_file", { path: "note.txt" }));
  await codeOf(r.broker.invoke(call("vault-registered-secret-42 Bearer abcdefghijklmnopqrstuvwxyz0123", {})));
  const text = JSON.stringify(r.events);
  assert.equal(text.includes("vault-registered-secret-42"), false);
  assert.equal(text.includes("abcdefghijklmnopqrstuvwxyz0123"), false);

  let ran = false;
  const failing = rig({ sink: { append: () => { throw new Error("disk full /secret"); } } });
  failing.broker.register({ name: "marker", tier: "read", args: z.object({}), run: async () => { ran = true; return 1; } });
  assert.equal(await codeOf(failing.broker.invoke(call("marker", {}))), "E_INTERNAL/audit-failed");
  assert.equal(ran, false, "nothing runs when the decision cannot be recorded");
  const asyncSink = rig({ sink: { append: () => Promise.reject(new Error("x")) as never } });
  asyncSink.broker.register({ name: "marker", tier: "read", args: z.object({}), run: async () => { ran = true; return 1; } });
  assert.equal(await codeOf(asyncSink.broker.invoke(call("marker", {}))), "E_INTERNAL/audit-failed");
  assert.equal(ran, false);
  // After the action ran, a failing result record says so.
  let n = 0;
  const late = rig({ sink: { append: () => { if (++n === 2) throw new Error("x"); return {} as never; } } });
  late.broker.register({ name: "marker", tier: "read", args: z.object({}), run: async () => { ran = true; return 1; } });
  await assert.rejects(late.broker.invoke(call("marker", {})), (e: unknown) => e instanceof BrokerError && e.details["executed"] === true);
});

test("errors carry only closed codes, fixed text and scalar details, never a cause or the request's strings", async () => {
  const r = rig();
  r.broker.register({ name: "boom", tier: "read", args: z.object({}), run: async () => { const e = new Error("password=hunter2 /home/me/.ssh"); (e as { code?: string }).code = "EACCES"; throw e; } });
  const seen: BrokerError[] = [];
  for (const make of [() => r.broker.invoke(call("boom", {})), () => r.broker.invoke(call("read_file", { path: "../../hunter2-path" })), () => r.broker.invoke(call("nope-hunter2", {}))]) {
    try {
      await make();
    } catch (e) {
      seen.push(e as BrokerError);
    }
  }
  assert.equal(seen.length, 3);
  for (const e of seen) {
    assert.ok(e instanceof BrokerError);
    assert.ok((ERROR_CODES as readonly string[]).includes(e.code));
    assert.equal((e as { cause?: unknown }).cause, undefined);
    assert.equal(/hunter2|\.ssh/.test(`${e.message} ${JSON.stringify(e.details)}`), false);
    assert.ok(Object.values(e.details).every((v) => ["string", "number", "boolean"].includes(typeof v)));
  }
  assert.equal(seen[0]?.code, "E_INTERNAL");
});

test("cancellation: an aborted call kills the command and the audit records it", async () => {
  const r = rig({ approve: (q) => user(q) });
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 300);
  const rec = (await r.broker.invoke(call("run", { command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"] }, { signal: ac.signal }))) as { endedBy: string };
  assert.equal(rec.endedBy, "aborted");
  assert.equal((r.events[r.events.length - 1]?.payload as { endedBy: string }).endedBy, "aborted");
  assert.equal(readFileSync(join(r.w.base, "outside", "secret.txt"), "utf8"), "TOP-SECRET");
});
