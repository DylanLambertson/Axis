// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// PV-M7 slice 2 end to end over the REAL composition in a child process (the headless slice): the user turns the CLI endpoint switch
// on (tier 4: the daemon's challenge, the window's approval, main's native confirmation), enables one CLI worker's messaging (the
// launch rule over main's entry), and starts the worker: its run gets an endpoint, a socket the CLI connects to, and a message it
// sends reaches the user. Turning the switch off revokes that endpoint at once (the socket closes and goes), and the worker's next
// run is started with no endpoint. The pty port is the production control slot over a real in-process pty service (slice-pty.ts).
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { approvalRequiredDetailsSchema } from "@axis/protocol";
import { createGitFixture, gitSkipReason, type GitFixture } from "../../testing/git-fixture.js";
import { TestClient, newKey, until } from "../../testing/test-client.js";
import { awaitRun, confirmNative, disposeHosts, registerProject, startHost, trustWindow } from "../../testing/slice-helpers.js";

const SUITE_TIMEOUT_MS = 240_000;
const skip = gitSkipReason() ?? (process.platform === "win32" ? "no CLI endpoint on Windows in 2a" : undefined);

/** A CLI the enable rule accepts (its real path is named `codex`, no flags) that dumps the two names it was given, then waits. */
function fakeCodex(dir: string): string {
  const bin = join(dir, "bin");
  mkdirSync(join(dir, "dumps"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  const path = join(bin, "codex");
  writeFileSync(
    path,
    `#!${process.execPath}\n` +
      `const { writeFileSync } = require("node:fs"); const { join, dirname } = require("node:path");\n` +
      `const out = { endpoint: process.env.AXIS_MESSAGES_ENDPOINT ?? null, token: process.env.AXIS_MESSAGES_TOKEN ?? null };\n` +
      `writeFileSync(join(dirname(__dirname), "dumps", String(process.pid) + ".json"), JSON.stringify(out));\n` +
      `setInterval(() => undefined, 60000);\n`,
  );
  chmodSync(path, 0o755);
  return path;
}
const frame = (o: unknown): Buffer => {
  const b = Buffer.from(JSON.stringify(o), "utf8");
  const h = Buffer.alloc(4);
  h.writeUInt32BE(b.length, 0);
  return Buffer.concat([h, b]);
};
async function call(s: Socket, o: unknown): Promise<Record<string, unknown>> {
  const got = new Promise<Buffer>((res) => {
    let buf = Buffer.alloc(0);
    const on = (d: Buffer): void => {
      buf = Buffer.concat([buf, d]);
      if (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
        s.off("data", on);
        res(buf.subarray(4, 4 + buf.readUInt32BE(0)));
      }
    };
    s.on("data", on);
  });
  s.write(frame(o));
  return JSON.parse((await got).toString("utf8")) as Record<string, unknown>;
}

describe("headless slice: the CLI endpoint switch end to end", { skip, timeout: SUITE_TIMEOUT_MS }, () => {
  let fx: GitFixture;
  let scratch: string;
  before(() => {
    fx = createGitFixture();
    scratch = realpathSync(mkdtempSync(join(tmpdir(), "axis-slice-ep-")));
  });
  after(async () => {
    await disposeHosts();
    fx.cleanup();
    rmSync(scratch, { recursive: true, force: true });
  });

  test("on natively, a worker's run gets an endpoint and its message reaches the user; off revokes it at once and the next run gets none", async () => {
    // A short runtime directory: a Unix socket path is bounded (the endpoint host refuses a longer one), and TMPDIR may be long.
    const runtime = realpathSync(mkdtempSync("/tmp/axr-"));
    after(() => rmSync(runtime, { recursive: true, force: true }));
    const codex = fakeCodex(scratch);
    const dumps = (): Array<{ endpoint: string | null; token: string | null }> =>
      readdirSync(join(scratch, "dumps")).sort().map((f) => JSON.parse(readFileSync(join(scratch, "dumps", f), "utf8")) as { endpoint: string | null; token: string | null });
    const h = await startHost(fx, { endpointRuntime: runtime, agents: [{ id: "codex", label: "Codex", command: [codex], args: [] }] });
    const sup = h.sup;
    await h.ready.catch((e: unknown) => assert.fail(`${String(e)}\n${sup.stderr}`));
    trustWindow(sup);
    const projectId = await registerProject(sup, fx.repo);
    const user = await TestClient.open(sup);
    const made = await user.ok<{ agent: { id: string } }>("axis.agents", "create", { projectId, name: "Cli worker", launch: { kind: "cli", entryId: "codex" }, home: { new: { name: "Cli home" } } }, newKey());
    const worker = made.agent.id;
    const enabled = await user.call("axis.messages", "updateSettings", { setting: "cliMessaging", agentId: worker, value: true });
    assert.equal((enabled.result as { changed?: boolean } | undefined)?.changed, true, `the worker's launch passes the rule: ${JSON.stringify(enabled.error ?? enabled.result)}`);

    // The switch: tier 4, approved in the window and confirmed natively by main.
    const asked = await user.call("axis.messages", "enableCliEndpoint", {});
    assert.equal(asked.error?.code, "E_APPROVAL_REQUIRED", JSON.stringify(asked.error));
    const { challenge } = approvalRequiredDetailsSchema.parse(asked.error?.details);
    await until(() => sup.nativeConfirms.some((c) => c.challengeId === challenge.challengeId), "native.confirm");
    await user.ok("axis.approvals", "resolve", { challengeId: challenge.challengeId, decision: "approve", digest: challenge.digest });
    await confirmNative(sup, user, challenge.challengeId);
    assert.deepEqual(await user.ok("axis.messages", "enableCliEndpoint", { approval: { challengeId: challenge.challengeId } }), { enabled: true, changed: true });

    // The worker's run, started after the switch went on in this running host: an endpoint without a restart.
    const firstCall = await user.call("axis.agents", "start", { agentId: worker }, newKey());
    assert.equal(firstCall.ok, true, `${JSON.stringify(firstCall.error)}\n${sup.stderr.slice(-3000)}`);
    const first = firstCall.result as { runId: string };
    await awaitRun(user, first.runId, "RUNNING");
    await until(() => dumps().length === 1, "the CLI started and dumped its names");
    const e = dumps()[0] as { endpoint: string; token: string };
    assert.ok(e.endpoint !== null && e.endpoint.startsWith(join(runtime, "axis")) && existsSync(e.endpoint), `the endpoint under the runtime directory: ${e.endpoint}`);
    const s = connect(e.endpoint);
    await new Promise<void>((res) => s.once("connect", () => res()));
    let closed = false;
    s.once("close", () => void (closed = true));
    assert.deepEqual(await call(s, { op: "auth", token: e.token }), { ok: true, op: "auth" });
    const sent = await call(s, { op: "send", id: "s1", recipients: [{ user: true }], body: "hello from the cli" });
    assert.equal(sent["ok"], true, JSON.stringify(sent));
    const read = await user.ok<{ messages: Array<{ body: { text: string }; sender: { verified: boolean } }> }>("axis.messages", "read", { threadId: sent["threadId"] });
    assert.deepEqual(read.messages.map((m) => [m.body.text, m.sender.verified]), [["hello from the cli", false]], "the user reads it, marked unverified");

    // Off: every live endpoint is revoked at once; the socket closes and its file goes.
    assert.deepEqual(await user.ok("axis.messages", "disableCliEndpoint", {}), { enabled: false, changed: true });
    await until(() => closed, "the CLI's connection closed by the eager revocation"); // bounded: a hang would not be a failure
    await until(() => !existsSync(e.endpoint), "the socket file is removed");

    // The worker's next run is started with no endpoint.
    await user.ok("axis.cli-runs", "stop", { runId: first.runId }, true);
    await until(async () => (await user.ok<{ run: { state: string } }>("axis.cli-runs", "get", { runId: first.runId })).run.state !== "RUNNING", "the first run stopped");
    // The workspace is busy until the first run's process is gone: start again until it is free.
    let second: { runId: string } | undefined;
    await until(async () => {
      const r = await user.call("axis.agents", "start", { agentId: worker }, newKey());
      if (r.ok === true) second = r.result as { runId: string };
      else assert.equal((r.error?.details as { reason?: string } | undefined)?.reason, "busy", JSON.stringify(r.error));
      return second !== undefined;
    }, "the second start");
    if (second === undefined) return assert.fail("no second run");
    await awaitRun(user, second.runId, "RUNNING");
    await until(() => dumps().length === 2, "the second run's CLI dumped its names");
    assert.equal(dumps().filter((d) => d.endpoint !== null).length, 1, "only the first run had an endpoint");
    assert.equal(dumps().filter((d) => d.endpoint === null && d.token === null).length, 1, "the second run had neither name");
    await user.ok("axis.cli-runs", "stop", { runId: second.runId }, true);
  });
});
