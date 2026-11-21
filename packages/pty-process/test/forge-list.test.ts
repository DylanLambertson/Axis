// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// PV-D2 slice 1b: `forge-list` in the pty process with a hostile fake `gh` through `pipeExec` (docs/design/forge-pr-list.md §1,
// §4, §7, §9). POSIX: the fake is a Node script with a shebang.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { forgeReplySchema } from "@axis/protocol";
import { createNodeExec } from "../src/index.js";
import { forgeReq, forgeRig, GH_VERSION_OK, type ForgeRig } from "../testing/forge.js";
import { until } from "../testing/helpers.js";

const SKIP = process.platform === "win32" ? "POSIX shebang scripts and process groups" : false;
const CANARY = "CANARY0d2s1b";

async function withRig(opts: Parameters<typeof forgeRig>[0], body: (r: ForgeRig) => Promise<void>): Promise<void> {
  const r = forgeRig(opts);
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
const versionRuns = (r: ForgeRig) => r.runs().filter((x) => x.args[0] === "--version");
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return !/^\d+ \(.*\) [ZX] /s.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return false;
  }
};

test("the call: closed template, generated config, empty cwd and data, the environment exactly as built", { skip: SKIP }, async () => {
  const dump = (out: string): string =>
    `const c = process.env.GH_CONFIG_DIR; fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({ env: process.env, cwdEntries: fs.readdirSync(process.cwd()), dataEntries: fs.readdirSync(process.env.XDG_DATA_HOME), config: Object.fromEntries(fs.readdirSync(c).map((f) => [f, fs.readFileSync(path.join(c, f), "utf8")])) })); fs.writeFileSync("left-behind", "x"); process.stdout.write("[]");`;
  const base = { PATH: "/usr/bin:/bin", HOME: "/home/u", LANG: "C.UTF-8", LC_ALL: "C", HTTPS_PROXY: "http://proxy:3128", SSL_CERT_FILE: "/etc/ca.pem", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/bus",
    GH_TOKEN: CANARY, GITHUB_TOKEN: CANARY, GH_REPO: "evil/x", GH_HOST: "evil.example", GH_PAGER: "less", GH_DEBUG: "api", GODEBUG: "x=1", LD_PRELOAD: "/nonexistent-axis.so", [`AXIS_CANARY_${process.pid}`]: CANARY, EDITOR: "vi" };
  await withRig({ baseEnv: base }, async (r) => {
    const out = join(r.dir, "dump.json");
    r.rewrite(dump(out));
    const reply = await ask(r);
    assert.deepEqual(reply, { t: "forge-result", req: reply["req"], exit: 0, class: "none", stdout: "[]", truncated: false });
    const [run] = listRuns(r);
    assert.deepEqual(run?.args, ["pr", "list", "--repo=github.com/acme/app", "--state=open", "--author=@me", "--limit=50", "--json=number,title,headRefName,author,isDraft,isCrossRepository,headRepositoryOwner,reviewDecision,statusCheckRollup"]);
    const seen = JSON.parse(readFileSync(out, "utf8")) as { env: Record<string, string>; cwdEntries: string[]; dataEntries: string[]; config: Record<string, string> };
    const call = dirname(run?.cwd as string);
    assert.equal(dirname(call), join(r.scratchParent, "forge-calls"));
    assert.match(call.slice(call.lastIndexOf("/") + 1), /^[0-9a-f]{32}$/);
    assert.deepEqual(seen.env, {
      PATH: "/usr/bin:/bin", HOME: "/home/u", LANG: "C.UTF-8", LC_ALL: "C", HTTPS_PROXY: "http://proxy:3128", SSL_CERT_FILE: "/etc/ca.pem",
      ...(process.platform === "linux" ? { DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/bus" } : {}),
      GH_CONFIG_DIR: join(call, "config"), XDG_CONFIG_HOME: join(call, "config"), XDG_DATA_HOME: join(call, "data"), XDG_STATE_HOME: join(call, "state"), XDG_CACHE_HOME: join(call, "cache"),
      GH_HOST: "github.com", GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GH_NO_EXTENSION_UPDATE_NOTIFIER: "1", GH_SPINNER_DISABLED: "1", NO_COLOR: "1", CLICOLOR: "0",
    });
    assert.deepEqual([seen.cwdEntries, seen.dataEntries], [[], []]);
    assert.match(seen.config["config.yml"] as string, /^version: "1"$/m);
    assert.deepEqual(Object.keys(seen.config).sort(), ["config.yml", "hosts.yml"]);
    assert.ok(!/user|oauth_token/.test(seen.config["hosts.yml"] as string));
    assert.deepEqual([r.execs.at(-1)?.maxOutput, r.execs.at(-1)?.maxStderr], [4 * 1024 * 1024, 64 * 1024], "stdout 4 MiB, stderr 64 KiB");
    // The file gh left in its cwd went with the call directory; the next call starts empty in a new directory.
    await until(() => readdirSync(join(r.scratchParent, "forge-calls")).length === 0);
    await ask(r);
    const again = JSON.parse(readFileSync(out, "utf8")) as { cwdEntries: string[] };
    assert.deepEqual(again.cwdEntries, []);
    assert.notEqual(listRuns(r)[1]?.cwd, run?.cwd, "a directory is never reused");
  });
});

test("the gate's fallback template has no --author", { skip: SKIP }, async () => {
  await withRig({ config: { authorFilter: false } }, async (r) => {
    await ask(r);
    assert.ok(!listRuns(r)[0]?.args.some((a) => a.startsWith("--author")));
    assert.ok(listRuns(r)[0]?.args.includes("--limit=50"));
  });
});

test("the version step: once per process on success, shared by concurrent first calls, never cached on failure", { skip: SKIP }, async () => {
  await withRig({}, async (r) => {
    const [a, b] = await Promise.all([ask(r), ask(r)]);
    await ask(r);
    assert.deepEqual([a["t"], b["t"]], ["forge-result", "forge-result"]);
    assert.equal(versionRuns(r).length, 1);
    assert.equal(listRuns(r).length, 3);
  });
  await withRig({ version: 'process.stdout.write("gh version 2.39.9 (2023-11-01)\\n");' }, async (r) => {
    assert.equal((await ask(r))["code"], "too_old");
    assert.equal(listRuns(r).length, 0, "an old gh never lists");
    r.rewrite('process.stdout.write("[]");', GH_VERSION_OK); // the user upgrades gh: no restart needed
    assert.equal((await ask(r))["t"], "forge-result");
    await ask(r);
    assert.equal(versionRuns(r).length, 2);
  });
});

test("hostile or missing version output is version_unknown; a missing gh is spawn_missing", { skip: SKIP }, async () => {
  const hostile = [
    'process.stdout.write("\\u001b[31mgh version 2.45.0\\n");',
    'process.stdout.write("gh version 2.45.0 " + "A".repeat(10000));',
    'process.stdout.write("hello\\n");',
    'process.stdout.write("gh version 2.45.0\\n"); process.exitCode = 1;',
  ];
  for (const version of hostile) {
    await withRig({ version }, async (r) => {
      assert.equal((await ask(r))["code"], "version_unknown", version);
      assert.equal(listRuns(r).length, 0);
    });
  }
  // Through the production exec function, which reports ENOENT as `not_found`.
  const missing = "/nonexistent-axis/bin/gh";
  await withRig({ config: { ghPath: missing }, exec: () => createNodeExec(new Set([missing]), process.platform) }, async (r) => {
    assert.deepEqual(await ask(r), { t: "forge-failed", req: r.replies[0]?.["req"], code: "spawn_missing" });
  });
  await withRig({ config: { ghPath: undefined } }, async (r) => {
    assert.equal((await ask(r))["code"], "spawn_missing");
    assert.equal(r.runs().length, 0);
  });
});

test("stderr leaves as a closed class only, whatever it holds", { skip: SKIP }, async () => {
  const cases: Array<[string, number, string]> = [
    ["HTTP 401: Bad credentials", 1, "auth_missing"],
    ["To get started with GitHub CLI, please run:  gh auth login", 4, "auth_missing"],
    ["The name org.freedesktop.secrets was not provided by any .service files", 1, "keyring"],
    ["failed to migrate config: cowardly refusing to continue with multi account migration", 1, "keyring"],
    ["GraphQL: Could not resolve to a Repository with the name 'acme/app'.", 1, "repo_missing"],
    ["dial tcp: lookup api.github.com: no such host", 1, "network"],
    ["unexpected", 2, "other"],
  ];
  await withRig({}, async (r) => {
    for (const [text, code, cls] of cases) {
      r.rewrite(`process.stderr.write(${JSON.stringify(`${CANARY} ${text}`)}); process.stdout.write(${JSON.stringify(CANARY)}); process.exitCode = ${code};`);
      const reply = await ask(r);
      assert.deepEqual([reply["exit"], reply["class"]], [code, cls], text);
      assert.ok(!JSON.stringify(reply).includes(text), "no stderr text in the reply");
    }
  });
});

test("caps: a 5 MiB stdout is truncated and not sent; 1 MiB of stderr does not truncate a 100 KiB list", { skip: SKIP }, async () => {
  await withRig({ list: 'process.stdout.write("x".repeat(5 * 1024 * 1024)); process.stderr.write("e".repeat(1024 * 1024));' }, async (r) => {
    assert.deepEqual(await ask(r), { t: "forge-result", req: r.replies[0]?.["req"], exit: 0, class: "none", stdout: "", truncated: true });
  });
  await withRig({ list: 'process.stderr.write("e".repeat(1024 * 1024)); process.stdout.write("[" + " ".repeat(100 * 1024) + "]");' }, async (r) => {
    const reply = await ask(r);
    assert.equal(reply["truncated"], false);
    assert.equal((reply["stdout"] as string).length, 100 * 1024 + 2);
  });
});

test("a hang is a timeout on the injected clock; its process group is killed and its directory removed", { skip: SKIP }, async () => {
  await withRig({ list: 'cp.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" }); setInterval(() => {}, 1000);' }, async (r) => {
    const pending = r.send(forgeReq());
    await until(() => listRuns(r).length === 1);
    r.clock.fire();
    assert.equal((await pending)["code"], "timeout");
    const pid = listRuns(r)[0]?.pid as number;
    await until(() => !alive(pid));
    await until(() => readdirSync(join(r.scratchParent, "forge-calls")).length === 0);
  });
});

test("at most two calls at once; the third is capacity; a closed control channel kills both and answers nothing", { skip: SKIP }, async () => {
  await withRig({ list: "setInterval(() => {}, 1000);" }, async (r) => {
    const first = forgeReq();
    const second = forgeReq();
    r.pair.a.send(first);
    r.pair.a.send(second);
    await until(() => listRuns(r).length === 2);
    assert.equal((await ask(r))["code"], "capacity");
    const pids = listRuns(r).map((x) => x.pid);
    r.pair.a.close();
    await until(() => pids.every((p) => !alive(p)));
    await until(() => readdirSync(join(r.scratchParent, "forge-calls")).length === 0);
    assert.equal(r.replies.filter((m) => m["req"] === first["req"] || m["req"] === second["req"]).length, 0);
  });
});

test("the call directory is checked just before the exec: anything planted refuses the call and never runs", { skip: SKIP }, async () => {
  const plants: Array<[string, (dir: string) => void]> = [
    ["an extension in data/", (d) => { mkdirSync(join(d, "data", "gh", "extensions", "gh-pr"), { recursive: true }); writeFileSync(join(d, "data", "gh", "extensions", "gh-pr", "gh-pr"), `#!/bin/sh\ntouch ${JSON.stringify(join(dirname(dirname(dirname(d))), "SENTINEL"))}\n`, { mode: 0o700 }); }],
    ["a line added to config.yml", (d) => writeFileSync(join(d, "config", "config.yml"), "http_unix_socket: /tmp/s\n", { flag: "a" })],
    ["an extra file in config/", (d) => writeFileSync(join(d, "config", "aliases.yml"), "")],
    ["a file in cwd/", (d) => writeFileSync(join(d, "cwd", "x"), "")],
    ["a sibling directory", (d) => mkdirSync(join(d, "state"))],
    ["data/ swapped for a link to an empty directory elsewhere", (d) => { const elsewhere = join(dirname(dirname(dirname(d))), "user-data"); mkdirSync(elsewhere); rmdirSync(join(d, "data")); symlinkSync(elsewhere, join(d, "data")); }],
  ];
  for (const [what, plant] of plants) {
    await withRig({ config: { afterPrepare: plant } }, async (r) => {
      assert.equal((await ask(r))["code"], "spawn_failed", what);
      assert.equal(r.runs().length, 0, `${what}: gh never ran`);
      assert.equal(existsSync(join(r.dir, "SENTINEL")), false);
      assert.deepEqual(readdirSync(join(r.scratchParent, "forge-calls")), [], "the refused directory is removed");
    });
  }
});

test("leftovers in the private root are swept at start; a link left in a call is removed without following it", { skip: SKIP }, async () => {
  const outside = (r: string): string => join(dirname(r), "outside");
  await withRig({
    before: (sp) => {
      mkdirSync(outside(sp));
      writeFileSync(join(outside(sp), "keep"), "k");
      const old = join(sp, "forge-calls", "0".repeat(32), "data", "gh", "extensions", "gh-pr");
      mkdirSync(old, { recursive: true });
      writeFileSync(join(old, "gh-pr"), "#!/bin/sh\n", { mode: 0o700 });
    },
    list: 'fs.symlinkSync(path.resolve(process.env.HOME, "outside"), "link"); fs.symlinkSync(path.resolve(process.env.HOME, "outside"), path.join(process.env.XDG_DATA_HOME, "link")); process.stdout.write("[]");',
  }, async (r) => {
    assert.deepEqual(readdirSync(join(r.scratchParent, "forge-calls")), [], "swept at start");
    await ask(r);
    await until(() => readdirSync(join(r.scratchParent, "forge-calls")).length === 0);
    assert.equal(readFileSync(join(r.dir, "outside", "keep"), "utf8"), "k", "the link's target is untouched");
  });
});

test("a request outside the shared schema is bad_request and starts nothing; one without a usable req gets no answer", { skip: SKIP }, async () => {
  await withRig({}, async (r) => {
    for (const over of [{ owner: "--upload-pack=x" }, { repo: ".." }, { host: "gitlab.com" }, { argv: ["x"] }, { env: { GH_TOKEN: "x" } }]) {
      assert.equal((await ask(r, over))["code"], "bad_request", JSON.stringify(over));
    }
    r.pair.a.send({ t: "forge-list", req: "bad req", host: "github.com", owner: "acme", repo: "app" });
    await r.send(forgeReq()); // ordered after it
    assert.equal(r.replies.some((m) => m["req"] === "bad req"), false);
    assert.equal(r.replies.some((m) => m["t"] === "spawn-failed"), false, "never answered in another family");
    assert.equal(listRuns(r).length, 1);
  });
});

test("exec start failures map to closed codes; program_refused is never a gh_missing", { skip: SKIP }, async () => {
  const { ExecStartError } = await import("../src/index.js");
  const throwing = (code: "program_refused" | "unsupported_platform" | "start_failed") => () => () => {
    throw new ExecStartError(code);
  };
  const rejecting = (code: "not_found" | "not_permitted" | "start_failed") => () => () => ({ done: Promise.reject(new ExecStartError(code)), kill: () => undefined });
  const cases: Array<[Parameters<typeof forgeRig>[0], string]> = [
    [{ exec: throwing("program_refused") }, "spawn_failed"],
    [{ exec: throwing("unsupported_platform") }, "unsupported_platform"],
    [{ exec: throwing("start_failed") }, "spawn_failed"],
    [{ exec: rejecting("not_found") }, "spawn_missing"],
    [{ exec: rejecting("not_permitted") }, "spawn_failed"],
    [{ exec: rejecting("start_failed") }, "spawn_failed"],
    [{ exec: () => () => ({ done: Promise.reject(new Error(CANARY)), kill: () => undefined }) }, "spawn_failed"],
  ];
  for (const [opts, code] of cases) {
    await withRig(opts, async (r) => {
      const reply = await ask(r);
      assert.equal(reply["code"], code);
      assert.ok(!JSON.stringify(reply).includes(CANARY));
    });
  }
});

test("Windows refuses before anything is created; a service without forge answers spawn_missing", async () => {
  const { createForgeList, createPtyService } = await import("../src/index.js");
  const { ManualClock, channelPair } = await import("../testing/helpers.js");
  const sent: unknown[] = [];
  const win = createForgeList({ exec: () => assert.fail("no exec on Windows"), ghPath: "C:\\gh\\gh.exe", scratchParent: "C:\\nonexistent-axis", baseEnv: {} }, new ManualClock(), "win32", (m) => void sent.push(m));
  win.handle(forgeReq({ req: "w1" }));
  win.handle(forgeReq({ req: "w2", repo: ".." }));
  assert.deepEqual(sent, [{ t: "forge-failed", req: "w1", code: "unsupported_platform" }, { t: "forge-failed", req: "w2", code: "bad_request" }]);
  const pair = channelPair();
  const service = createPtyService({ spawn: () => assert.fail("no spawn"), clock: new ManualClock() });
  service.serveControl(pair.b);
  const replies: unknown[] = [];
  pair.a.onMessage((m) => void replies.push(m));
  pair.a.send(forgeReq({ req: "n1" }));
  await until(() => replies.length === 1);
  assert.deepEqual(replies, [{ t: "forge-failed", req: "n1", code: "spawn_missing" }]);
  service.dispose();
});
