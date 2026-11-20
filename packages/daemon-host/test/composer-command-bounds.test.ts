// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { START } from "./composer-rig.js";
import { MAX_ARGV_JSON, runCommandArgsOn } from "../src/index.js";
import { NODE, approveCommand, approvalsOf, command, commandRig, eventually, fakeGuard, nodeScript, posix, toolsOf } from "./composer-command-rig.js";

// Review c3 r1 SF-3: a command the approval hook could not be shown whole (the broker escapes, redacts and cuts its line) is
// refused with a closed reason before anything is asked, never declined as if the user had said no.

const TEXT = { kind: "text", text: "done" } as const;
const ended = (c: { service: { get(id: string): { live: boolean } } }, runId: string) => () => !c.service.get(runId).live;
/** `node -e <code> <pad>` whose argv is exactly `units` UTF-16 units as JSON. */
const padded = (code: string, units: number): string[] => {
  const base = JSON.stringify([NODE, "-e", code, ""]).length;
  return [NODE, "-e", code, "x".repeat(units - base)];
};

test("SF-3: an argument the broker would rewrite or a line past the bound is refused as invalid_args; nothing is asked", async (t) => {
  const c = await commandRig(t, {
    replies: [
      command([NODE, "-e", "1", "x".repeat(1000)]), // PROBE1: within one argument's bound, past the line's
      command([NODE, "-e", "1", "a​b"]), // PROBE2: a format character
      command([NODE, "-e", "1", "a‮b"]), // a bidirectional control
      command([NODE, "-e", "1", "a b"]), // a line separator (JSON leaves it raw)
      command([NODE, "-e", "1", "a\u0085b"]), // a C1 control (JSON leaves it raw)
      command(padded("1", MAX_ARGV_JSON + 1)),
      TEXT,
    ],
    commandGuard: fakeGuard(),
  });
  const { run } = await c.service.start(START(c.workspaceId), new AbortController().signal);
  await eventually(ended(c, run.runId));
  assert.deepEqual(toolsOf(c, run.runId).map((e) => e.reason), Array(6).fill("invalid_args"));
  assert.deepEqual(approvalsOf(c, run.runId), [], "nothing was put to the user");
  assert.equal(c.service.get(run.runId).state, "REVIEWING");
});

test("SF-3: the schema refuses a line the redactor would change (the provider guard redacts a secret first; this is the backstop)", () => {
  const schema = runCommandArgsOn(process.platform, (t) => t.replace("SECRET", "[redacted]"));
  assert.equal(schema.safeParse({ argv: [NODE, "SECRET"] }).success, false);
  assert.equal(schema.safeParse({ argv: [NODE, "public"] }).success, true);
});

test("SF-3: a newline is JSON-escaped (display-safe as it is) and a line of exactly the bound is shown whole and runs", async (t) => {
  const marker = "at-bound";
  const code = `require("fs").writeFileSync(${JSON.stringify(marker)}, process.argv[1])`;
  const argv = padded(code, MAX_ARGV_JSON);
  assert.equal(JSON.stringify(argv).length, MAX_ARGV_JSON);
  const c = await commandRig(t, { replies: [command(argv), command([NODE, "-e", "1", "a\nb"]), TEXT], commandGuard: fakeGuard() });
  const { run } = await c.service.start(START(c.workspaceId), new AbortController().signal);
  await approveCommand(c, run.runId);
  await approveCommand(c, run.runId);
  await eventually(ended(c, run.runId));
  assert.deepEqual(toolsOf(c, run.runId).map((e) => e.outcome), ["ok", "ok"]);
  assert.equal(existsSync(join(c.root, marker)), true);
  assert.deepEqual(approvalsOf(c, run.runId).filter((e) => e.state === "requested").map((e) => e.preview?.command?.argv.length), [4, 4]);
});

test("SF-3: a program whose real path pushes the line past what the hook is shown is refused (invalid_command), not declined", { skip: !posix }, async (t) => {
  // A deep directory outside the tree on PATH: the argv is a short bare name, the pinned real path alone is past 1024 units.
  const deep = (outside: string): string => [0, 1, 2, 3, 4].reduce((dir, i) => join(dir, `${"d".repeat(200)}${i}`), outside);
  const c = await commandRig(t, {
    script: ({ outside }) => {
      mkdirSync(deep(outside), { recursive: true });
      return nodeScript(join(deep(outside), "axis-deep-prog"), "process.exit(0)") ? [command(["axis-deep-prog"]), TEXT] : [TEXT];
    },
    env: ({ outside, base }) => ({ PATH: deep(outside), HOME: base }),
    commandGuard: fakeGuard(),
  });
  const { run } = await c.service.start(START(c.workspaceId), new AbortController().signal);
  await eventually(ended(c, run.runId));
  const tools = toolsOf(c, run.runId);
  if (tools.length === 0) return t.skip("this system cannot run a #! script");
  assert.deepEqual(tools.map((e) => e.reason), ["invalid_command"]);
  assert.deepEqual(approvalsOf(c, run.runId), [], "nothing was put to the user");
});
