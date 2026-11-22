// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// PV-D2 slice 2 (docs/design/forge-pr-list.md §9 "Slice 2"): the hostile fake `gh` suite rerun through the production exec
// function (`createNodeExec`, PV-X1a) instead of `pipeExec`: its caps, its group kill (a grandchild that holds the pipes and
// ignores SIGTERM included), the environment exactly as built, and the markers v2 classifier on what it collected.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { forgeReplySchema } from "@axis/protocol";
import { createNodeExec, FORGE_STDERR_MARKERS_VERSION } from "../src/index.js";
import { forgeReq, forgeRig, type ForgeRig } from "../testing/forge.js";
import { until } from "../testing/helpers.js";

const SKIP = process.platform === "win32" ? "POSIX shebang scripts and process groups" : false;
const CANARY = "CANARY0d2s2node";

async function withRig(opts: Parameters<typeof forgeRig>[0], body: (r: ForgeRig) => Promise<void>): Promise<void> {
  const r = forgeRig({ ...opts, exec: (_inner, gh) => createNodeExec(new Set([gh]), process.platform) });
  try {
    await body(r);
  } finally {
    r.cleanup();
  }
}
const ask = async (r: ForgeRig, over: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
  const reply = await r.send(forgeReq(over));
  assert.equal(forgeReplySchema.safeParse(reply).success, true, JSON.stringify(reply).slice(0, 200));
  return reply;
};
const listRuns = (r: ForgeRig) => r.runs().filter((x) => x.args[0] !== "--version");
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return !/^\d+ \(.*\) [ZX] /s.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return false;
  }
};
const callsEmpty = (r: ForgeRig) => (): boolean => readdirSync(join(r.scratchParent, "forge-calls")).length === 0;

test("real exec: the environment is exactly the built one (no token, no planted name), and a file left in the cwd goes with the call", { skip: SKIP }, async () => {
  const base = { PATH: "/usr/bin:/bin", HOME: "/home/u", LANG: "C.UTF-8", GH_TOKEN: CANARY, GITHUB_TOKEN: CANARY, GH_ENTERPRISE_TOKEN: CANARY, GH_HOST: "evil.example", GH_REPO: "evil/x", GODEBUG: "x=1", LD_PRELOAD: "/nonexistent-axis.so", DYLD_INSERT_LIBRARIES: "/x", [`AXIS_CANARY_${process.pid}`]: CANARY, BROWSER: "evil" };
  await withRig({ baseEnv: base }, async (r) => {
    const out = join(r.dir, "env.json");
    r.rewrite(`fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.env)); fs.writeFileSync("left-behind", "x"); process.stdout.write("[]");`);
    assert.deepEqual(await ask(r), { t: "forge-result", req: r.replies[0]?.["req"], exit: 0, class: "none", stdout: "[]", truncated: false });
    const call = dirname(listRuns(r)[0]?.cwd as string);
    assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), {
      PATH: "/usr/bin:/bin", HOME: "/home/u", LANG: "C.UTF-8",
      GH_CONFIG_DIR: join(call, "config"), XDG_CONFIG_HOME: join(call, "config"), XDG_DATA_HOME: join(call, "data"), XDG_STATE_HOME: join(call, "state"), XDG_CACHE_HOME: join(call, "cache"),
      GH_HOST: "github.com", GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GH_NO_EXTENSION_UPDATE_NOTIFIER: "1", GH_SPINNER_DISABLED: "1", NO_COLOR: "1", CLICOLOR: "0",
    });
    assert.ok(!readFileSync(out, "utf8").includes(CANARY));
    await until(callsEmpty(r));
    r.rewrite('process.stdout.write(JSON.stringify(fs.readdirSync(process.cwd())));');
    assert.equal((await ask(r))["stdout"], "[]", "the next call's cwd is new and empty");
  });
});

test("real exec: 5 MiB on stdout is cut at the cap and never sent; 1 MiB of stderr is held to its own cap and does not cut a list", { skip: SKIP }, async () => {
  await withRig({ list: 'process.stdout.write("x".repeat(5 * 1024 * 1024)); process.stderr.write("e".repeat(1024 * 1024));' }, async (r) => {
    assert.deepEqual(await ask(r), { t: "forge-result", req: r.replies[0]?.["req"], exit: 0, class: "none", stdout: "", truncated: true });
  });
  await withRig({ list: 'process.stderr.write("HTTP 401 " + "e".repeat(1024 * 1024)); process.stdout.write("[" + " ".repeat(100 * 1024) + "]");' }, async (r) => {
    const reply = await ask(r);
    assert.deepEqual([reply["truncated"], (reply["stdout"] as string).length, reply["class"]], [false, 100 * 1024 + 2, "none"], "exit 0 is none whatever stderr holds");
  });
});

test("real exec: endless stderr and a hang end as a timeout on the injected clock; the group is killed and the directory removed", { skip: SKIP }, async () => {
  const endless = 'const chunk = "\\u001b[31m" + "e".repeat(65536); const pump = () => process.stderr.write(chunk, pump); pump();';
  for (const list of [endless, "setInterval(() => {}, 1000);"]) {
    await withRig({ list }, async (r) => {
      const pending = r.send(forgeReq());
      await until(() => listRuns(r).length === 1);
      r.clock.fire();
      assert.equal((await pending)["code"], "timeout");
      const pid = listRuns(r)[0]?.pid as number;
      await until(() => !alive(pid));
      await until(callsEmpty(r));
    });
  }
});

test("real exec: a grandchild that holds the pipes and ignores SIGTERM is killed with the group when gh exits; the reply still comes", { skip: SKIP }, async () => {
  await withRig({}, async (r) => {
    const pidFile = join(r.dir, "grandchild.pid");
    r.rewrite(`const g = cp.spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); require('fs').writeFileSync(${JSON.stringify(pidFile).replace(/"/g, "'")}, String(process.pid)); setInterval(() => {}, 1000);"], { stdio: "inherit" }); g.unref(); while (!fs.existsSync(${JSON.stringify(pidFile)})) {} process.stdout.write("[]");`);
    assert.deepEqual(await ask(r), { t: "forge-result", req: r.replies[0]?.["req"], exit: 0, class: "none", stdout: "[]", truncated: false });
    const grandchild = Number(readFileSync(pidFile, "utf8"));
    assert.ok(grandchild > 0);
    await until(() => !alive(grandchild));
    await until(callsEmpty(r));
  });
});

test("real exec: wrong JSON, invalid UTF-8 and terminal controls come back as bounded text for the daemon's strict parse", { skip: SKIP }, async () => {
  const cases: Array<[string, (s: string) => boolean]> = [
    ['process.stdout.write("{not json");', (s) => s === "{not json"],
    ['process.stdout.write(Buffer.from([0x5b, 0xff, 0xfe, 0xc3, 0x5d]));', (s) => s === "[\ufffd\ufffd\ufffd]"],
    // Raw controls on stdout (not JSON-escaped): passed on as text; the daemon's parse refuses them, its escaping covers the rest.
    ['process.stdout.write("[{\\"title\\": \\"\\u001b]8;;https://evil.example\\u0007x\\u001b]8;;\\u0007\\u202e\\u009b\\"}]");', (s) => s.includes("\u001b]8;;https://evil.example\u0007") && s.includes("\u202e\u009b")],
  ];
  await withRig({}, async (r) => {
    for (const [list, check] of cases) {
      r.rewrite(list);
      const reply = await ask(r);
      assert.deepEqual([reply["t"], reply["exit"], reply["truncated"]], ["forge-result", 0, false], list);
      assert.ok(check(reply["stdout"] as string), list);
    }
  });
});

test(`real exec: the markers v${FORGE_STDERR_MARKERS_VERSION} classifier reads what the exec function collected`, { skip: SKIP }, async () => {
  const cases: Array<[string, number, string]> = [
    ["HTTP 401: Bad credentials (https://api.github.com/graphql)", 1, "auth_missing"],
    ["The name org.freedesktop.secrets was not provided by any .service files", 1, "keyring"],
    ["GraphQL: Could not resolve to a Repository with the name 'acme/app'.", 1, "repo_missing"],
    ["dial tcp: lookup api.github.com: no such host", 1, "network"],
    ["anything else", 3, "other"],
  ];
  await withRig({}, async (r) => {
    for (const [text, code, cls] of cases) {
      r.rewrite(`process.stderr.write(${JSON.stringify(text)}); process.exitCode = ${code};`);
      const reply = await ask(r);
      assert.deepEqual([reply["exit"], reply["class"], reply["stdout"]], [code, cls, ""], text);
      assert.ok(!JSON.stringify(reply).includes(text.slice(0, 12)), "no stderr text leaves");
    }
  });
});
