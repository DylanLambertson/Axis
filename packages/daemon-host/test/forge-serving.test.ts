// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// PV-D2 slice 2 end to end: `axis.forge/1` as the composition registers it (`registerForgeServing`), over the host's real pty port
// (`createPtyProcessPort`), the real pty service and its production exec function (`createNodeExec`), a hostile fake `gh`, and a
// real repository whose `origin` the daemon reads with its own pinned git. Recorded-shape `gh` JSON with hostile fields comes back
// filtered and display-escaped; a restart forgets the pin (fail closed); the reply mapping holds through the whole stack.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { Handler, HandlerContext } from "@axis/daemon";
import { createNodeExec, createPtyProcessPort, createPtyService } from "@axis/pty-process";
import { createSecretScanner } from "@axis/secret-scan";
import type { AuditEventInput } from "@axis/audit";
import { createGitPort, createOriginReader, forgeLogLine, MAX_ORIGIN_CHARS, registerForgeServing, type ForgeServingDeps, type HandlerRegistrar, type Logger } from "../src/index.js";
import { channelPair } from "./pty-process-rig.js";
import { gitSkipReason, worktreesRig, type Rig } from "./worktrees-rig.js";

const SKIP = process.platform === "win32" ? "POSIX shebang scripts and process groups" : (gitSkipReason() ?? false);
const USER = { actor: "user", clientKind: "desktop" };
const ctx = (): HandlerContext => ({ identity: USER, requestId: "q", correlationId: "c", signal: new AbortController().signal }) as unknown as HandlerContext;
const PATHS = "/usr/bin:/bin";
/** Planted in the pty process's startup environment: none of it may reach gh (review 1 N-3). */
const PLANTED = { GH_TOKEN: "CANARY_TOKEN_9c1", GITHUB_TOKEN: "CANARY_TOKEN_9c1", GH_ENTERPRISE_TOKEN: "CANARY_TOKEN_9c1", GITHUB_ENTERPRISE_TOKEN: "CANARY_TOKEN_9c1", GH_REPO: "evil/x", GH_HOST: "evil.example", GH_DEBUG: "api", GIT_DIR: "/evil", GIT_CONFIG_GLOBAL: "/evil" };
/** The only GH_* names gh gets: the ones the pty process sets itself (§4). */
const GH_SET = ["GH_CONFIG_DIR", "GH_HOST", "GH_NO_EXTENSION_UPDATE_NOTIFIER", "GH_NO_UPDATE_NOTIFIER", "GH_PROMPT_DISABLED", "GH_SPINNER_DISABLED"];

/** A fake `gh` (Node, with a shebang) that answers `--version` and otherwise replays `out`, `err` and `code` from its directory. */
function fakeGh(dir: string): { gh: string; set(out: string | Buffer, err?: string, code?: number): void; runs(): string[][]; envs(): Array<Record<string, string>> } {
  mkdirSync(dir, { mode: 0o700 });
  const gh = join(dir, "gh");
  const at = (f: string): string => JSON.stringify(join(dir, f));
  writeFileSync(gh, [
    `#!${process.execPath}`,
    'const fs = require("fs");',
    `fs.appendFileSync(${at("gh.log")}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
    `fs.appendFileSync(${at("env.log")}, JSON.stringify(process.env) + "\\n");`,
    'if (process.argv[2] === "--version") { process.stdout.write("gh version 2.45.0 (2024-03-04)\\n"); } else {',
    `  process.stderr.write(fs.readFileSync(${at("err")}));`,
    `  process.stdout.write(fs.readFileSync(${at("out")}), () => process.exit(Number(fs.readFileSync(${at("code")}, "utf8"))));`,
    "}",
    "",
  ].join("\n"), { mode: 0o700 });
  chmodSync(gh, 0o700);
  writeFileSync(join(dir, "gh.log"), "");
  writeFileSync(join(dir, "env.log"), "");
  const set = (out: string | Buffer, err = "", code = 0): void => {
    writeFileSync(join(dir, "out"), out);
    writeFileSync(join(dir, "err"), err);
    writeFileSync(join(dir, "code"), String(code));
  };
  set("[]");
  return { gh, set, runs: () => readFileSync(join(dir, "gh.log"), "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as string[]).filter((a) => a[0] !== "--version"),
    envs: () => readFileSync(join(dir, "env.log"), "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as Record<string, string>) };
}

const row = (n: number, over: Record<string, unknown> = {}) => ({
  number: n, title: `pr ${n}`, headRefName: `axis/b${n}`, author: { login: "dev" }, isDraft: false, isCrossRepository: false,
  headRepositoryOwner: { login: "acme" }, reviewDecision: "APPROVED", statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }], ...over,
});
const HOSTILE = "\u001b[31mRed\u001b]8;;https://evil.example/\u0007click\u001b]8;;\u0007 ‮gnp.exe⁦ \u009b2J\u0000";
const CONTROLS = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/;

interface Served {
  readonly rig: Rig;
  readonly gh: ReturnType<typeof fakeGh>;
  readonly audit: AuditEventInput[];
  serve(over?: Partial<ForgeServingDeps>): Readonly<Record<string, Handler>>;
  tick(): void;
}

async function served(t: TestContext): Promise<Served> {
  const rig = await worktreesRig();
  t.after(() => rig.cleanup());
  rig.git(rig.repo, "remote", "add", "origin", "https://github.com/acme/app.git");
  const gh = fakeGh(join(rig.tmp, "gh-bin"));
  const scratch = join(rig.tmp, "pty-scratch");
  mkdirSync(scratch, { mode: 0o700 });
  const service = createPtyService({
    spawn: () => {
      throw new Error("no terminals here");
    },
    forge: { exec: createNodeExec(new Set([gh.gh]), process.platform), ghPath: gh.gh, scratchParent: scratch, baseEnv: { PATH: PATHS, HOME: rig.home, ...PLANTED } },
  });
  const pair = channelPair();
  service.serveControl(pair.b);
  const port = createPtyProcessPort({ channel: pair.a });
  t.after(() => (port.dispose(), service.dispose()));
  const git = createGitPort({ gitPath: rig.gitPath, env: { daemon: { PATH: PATHS, HOME: rig.home }, pty: {} }, platform: process.platform, runHooks: false, scanner: createSecretScanner({ mode: "refuse" }), assertNoDrift: async () => undefined });
  const audit: AuditEventInput[] = [];
  let now = 1_000_000;
  const serve = (over: Partial<ForgeServingDeps> = {}): Readonly<Record<string, Handler>> => {
    let handlers: Readonly<Record<string, Handler>> | undefined;
    const registrar: HandlerRegistrar = { register: (c, v, h) => void (assert.deepEqual([c, v], ["axis.forge", 1]), (handlers = h)) };
    registerForgeServing(registrar, {
      pty: port,
      projectPath: (id) => rig.journal.getProject(id)?.path,
      git,
      platform: process.platform,
      audit: (e) => void audit.push(e),
      monotonic: () => now,
      ...over,
    });
    return handlers as Readonly<Record<string, Handler>>;
  };
  return { rig, gh, audit, serve, tick: () => void (now += 20_000) };
}

const call = (h: Readonly<Record<string, Handler>>, method: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> =>
  (h[method] as Handler)(ctx(), payload as never) as Promise<Record<string, unknown>>;

test("confirm, then list: hostile gh rows are filtered and escaped, links are daemon-built, nothing runs before the pin", { skip: SKIP }, async (t) => {
  const s = await served(t);
  const logged: unknown[] = [];
  const h = s.serve({ logger: { info: (event: string, fields: unknown) => void logged.push([event, fields]) } as unknown as Logger });
  const projectId = s.rig.projectId;
  const first = await call(h, "pullRequests", { projectId, trigger: "view" });
  assert.deepEqual(first, { state: "repository_unconfirmed", candidate: { host: "github.com", owner: "acme", repo: "app" } });
  assert.equal(s.gh.runs().length, 0, "no gh before the user confirms");
  s.gh.set(JSON.stringify([
    row(1, { title: HOSTILE }),
    row(2, { isCrossRepository: true, headRefName: "axis/ü-fork", title: "F".repeat(5000) }),
    row(3, { title: "T".repeat(1000), isDraft: true, reviewDecision: "CHANGES_REQUESTED" }),
    row(7, { author: { login: "dev‮" } }),
    row(8, { title: "T".repeat(5000) }),
    row(4, { headRefName: "main" }),
    row(5, { headRepositoryOwner: { login: "evil" } }),
    row(6, { headRefName: "axis/x", url: "https://evil.example/pull/6", number: 6 }),
  ]));
  assert.deepEqual(await call(h, "pinRepository", { projectId, host: "github.com", owner: "acme", repo: "app" }), { repository: { host: "github.com", owner: "acme", repo: "app" } });
  const listed = await call(h, "pullRequests", { projectId, trigger: "user" });
  assert.equal(listed["state"], "ok", JSON.stringify(listed).slice(0, 300));
  const rows = listed["rows"] as Array<Record<string, unknown>>;
  assert.deepEqual(rows.map((r) => r["number"]), [1, 3, 6], "fork, non-axis and foreign-owner rows dropped");
  assert.equal(listed["invalidRows"], 2, "a kept row with a bidi login or a 5,000-unit title fails the strict check and is counted");
  for (const r of rows) {
    for (const f of ["title", "branch", "author"]) assert.doesNotMatch(r[f] as string, CONTROLS, `${String(r["number"])}.${f}`);
    assert.equal(r["url"], `https://github.com/acme/app/pull/${String(r["number"])}`, "the link is built by the daemon, never taken from gh");
  }
  assert.match(rows[0]?.["title"] as string, /Red/);
  assert.equal(rows[1]?.["title"], `${"T".repeat(200)}…`, "a long title is cut with an ellipsis");
  assert.deepEqual([rows[1]?.["draft"], rows[1]?.["review"], rows[0]?.["checks"]], [true, "changes_requested", "passing"]);
  assert.deepEqual(s.gh.runs()[0], ["pr", "list", "--repo=github.com/acme/app", "--state=open", "--author=@me", "--limit=50", "--json=number,title,headRefName,author,isDraft,isCrossRepository,headRepositoryOwner,reviewDecision,statusCheckRollup"]);
  const text = JSON.stringify(s.audit);
  assert.ok(!text.includes("Red") && !text.includes("CANARY_TOKEN") && !text.includes("evil"), "the audit carries ids, states and counts only");
  assert.deepEqual(s.audit.map((e) => e.action), ["forge.pin", "forge.pull_requests"]);
  assert.deepEqual(logged, [["forge.list", { reason: "ok", code: "0" }]], "one closed log record per gh run");
  const envs = s.gh.envs();
  assert.equal(envs.length, 2, "the version step and the list");
  for (const env of envs) {
    const names = Object.keys(env);
    assert.deepEqual(names.filter((n) => n.startsWith("GH_")).sort(), GH_SET, "only the GH_ names the pty process sets");
    assert.deepEqual(names.filter((n) => n.startsWith("GITHUB_") || n.startsWith("GIT_")), [], "no GITHUB_ or GIT_ name");
    assert.equal(env["GH_HOST"], "github.com");
    assert.ok(!JSON.stringify(env).includes("CANARY_TOKEN") && !JSON.stringify(env).includes("evil"), "no planted value");
  }
});

test("the exec log line becomes a closed record; any other line is dropped", () => {
  const logged: unknown[] = [];
  const log = forgeLogLine({ info: (event: string, fields: unknown) => void logged.push([event, fields]) } as unknown as Logger);
  log("forge: state=not_logged_in exit=4");
  log("forge: state=timeout exit=none");
  for (const bad of ["forge: state=ok exit=0 Red", "forge: state=Ok exit=0", "forge: state=ok exit=1234", "x forge: state=ok exit=0"]) log(bad);
  assert.deepEqual(logged, [["forge.list", { reason: "not_logged_in", code: "4" }], ["forge.list", { reason: "timeout", code: "none" }]]);
  forgeLogLine(undefined)("forge: state=ok exit=0");
});

test("restart: the in-memory pin is gone, so the project is unconfirmed again and gh does not run (slice 2b persists it)", { skip: SKIP }, async (t) => {
  const s = await served(t);
  const projectId = s.rig.projectId;
  const before = s.serve();
  await call(before, "pinRepository", { projectId, host: "github.com", owner: "acme", repo: "app" });
  assert.equal((await call(before, "pullRequests", { projectId, trigger: "user" }))["state"], "ok");
  s.tick();
  const after = s.serve(); // what a restarted host registers
  for (const trigger of ["view", "user"]) {
    assert.deepEqual(await call(after, "pullRequests", { projectId, trigger }), { state: "repository_unconfirmed", candidate: { host: "github.com", owner: "acme", repo: "app" } });
  }
  assert.equal(s.gh.runs().length, 1, "only the run before the restart");
});

test("the reply mapping through the whole stack: too much output, wrong JSON, invalid UTF-8, not logged in, no pty process", { skip: SKIP }, async (t) => {
  const s = await served(t);
  const projectId = s.rig.projectId;
  const h = s.serve();
  await call(h, "pinRepository", { projectId, host: "github.com", owner: "acme", repo: "app" });
  const cases: Array<[string | Buffer, string, number, string]> = [
    ["[" + " ".repeat(5 * 1024 * 1024) + "]", "", 0, "output_too_large"],
    ["{not json", "", 0, "output_invalid"],
    [Buffer.from([0x5b, 0xff, 0x5d]), "", 0, "output_invalid"],
    ["", "HTTP 401: Bad credentials (https://api.github.com/graphql)", 1, "not_logged_in"],
  ];
  for (const [out, err, code, state] of cases) {
    s.tick();
    s.gh.set(out, err, code);
    const answer = await call(h, "pullRequests", { projectId, trigger: "user" });
    assert.equal(answer["state"], state, `${state}: ${JSON.stringify(answer).slice(0, 200)}`);
    assert.ok(!JSON.stringify(answer).includes("Bad credentials"));
  }
  const none = s.serve({ pty: {} });
  await call(none, "pinRepository", { projectId, host: "github.com", owner: "acme", repo: "app" });
  assert.equal((await call(none, "pullRequests", { projectId, trigger: "user" }))["state"], "unavailable", "a pty port without forgeList");
});

test("origin is read from the project's main checkout only: a moved, linked, nested or over-long one names no repository", { skip: SKIP }, async (t) => {
  const s = await served(t);
  const { rig } = s;
  const git = createGitPort({ gitPath: rig.gitPath, env: { daemon: { PATH: PATHS, HOME: rig.home }, pty: {} }, platform: process.platform, runHooks: false, scanner: createSecretScanner({ mode: "refuse" }), assertNoDrift: async () => undefined });
  const uid = process.getuid?.();
  const read = (path: string) => createOriginReader({ projectPath: (id) => (id === "p" ? path : undefined), git, platform: process.platform, uid })("p");
  assert.deepEqual(await read(rig.repo), { kind: "url", url: "https://github.com/acme/app.git" });
  await assert.rejects(read(join(rig.repo, "sub")), "a directory inside the checkout is not its root");
  const link = join(rig.tmp, "repo-link");
  symlinkSync(rig.repo, link);
  await assert.rejects(read(link), "a recorded path that is now a symlink");
  const linked = join(rig.tmp, "linked");
  rig.git(rig.repo, "worktree", "add", "-q", "-b", "side", linked);
  await assert.rejects(read(linked), "a linked worktree is not the main checkout");
  await assert.rejects(createOriginReader({ projectPath: () => undefined, git, platform: process.platform, uid })("p"));
  await assert.rejects(createOriginReader({ projectPath: () => rig.repo, git, platform: process.platform, uid: undefined })("p"), "no uid: refused, never skipped");
  rig.git(rig.repo, "remote", "set-url", "origin", `https://github.com/acme/${"a".repeat(MAX_ORIGIN_CHARS)}`);
  await assert.rejects(read(rig.repo), "an over-long origin is refused, never cut");
  rig.git(rig.repo, "remote", "set-url", "origin", `https://github.com/acme/${"a".repeat(MAX_ORIGIN_CHARS - 30)}`);
  assert.equal(((await read(rig.repo)) as { url: string }).url.length, MAX_ORIGIN_CHARS - 6, "just under the bound is read whole");
  rig.git(rig.repo, "remote", "remove", "origin");
  assert.deepEqual(await read(rig.repo), { kind: "none" });
});

test("review 1 N-2: a .git that is not a real directory (a gitdir: file, a symlink) names no repository, as at registration", { skip: SKIP }, async (t) => {
  const { rig } = await served(t);
  const git = createGitPort({ gitPath: rig.gitPath, env: { daemon: { PATH: PATHS, HOME: rig.home }, pty: {} }, platform: process.platform, runHooks: false, scanner: createSecretScanner({ mode: "refuse" }), assertNoDrift: async () => undefined });
  const read = (path: string) => createOriginReader({ projectPath: () => path, git, platform: process.platform, uid: process.getuid?.() })("p");
  // `projects/binding.ts` refuses both at registration; the forge read mirrors it (one project per object store).
  const separate = join(rig.tmp, "separate");
  const elsewhere = join(rig.tmp, "elsewhere.git");
  rig.git(rig.tmp, "init", "-q", `--separate-git-dir=${elsewhere}`, separate);
  rig.git(separate, "remote", "add", "origin", "https://github.com/acme/other.git");
  await assert.rejects(read(separate), "a gitdir: file");
  const viaLink = join(rig.tmp, "via-link");
  mkdirSync(viaLink);
  symlinkSync(elsewhere, join(viaLink, ".git"));
  await assert.rejects(read(viaLink), "a .git symlink");
});
