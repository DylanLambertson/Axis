// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// A scripted git runner for cases a real worktree cannot produce (hostile paths, lying diffs). It answers only the calls
// the package makes, and still goes through the hardened-prefix guard like a real one.
import type { GitOpsDeps, GitRunRequest, GitRunResult, WorktreeRef } from "@axis/git-ops";
import type { ReviewDeps } from "../src/index.js";
import { tempIndexes } from "./fixture.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const Z40 = "0".repeat(40);
const oid = (n: number): string => n.toString(16).padStart(40, "0");

export interface FakeFixture {
  readonly counts: { created: number; disposed: number; dir: string };
  readonly deps: ReviewDeps;
  readonly wt: WorktreeRef;
  readonly against: string;
  readonly calls: GitRunRequest[];
}

type Entry = readonly [status: "A" | "M" | "D", path: string];

/** A runner whose tree diff reports `entries` (no content is ever read back), and whose `diff` returns `patch`. */
export function fakeFixture(entries: readonly Entry[], opts: { patch?: string; blobs?: Record<string, string>; raw?: string; verifyRaw?: string; numstat?: string; version?: string; failOn?: string; patchCode?: number; throwOn?: string; error?: unknown } = {}): FakeFixture {
  const calls: GitRunRequest[] = [];
  const result = (stdout: string, code = 0): GitRunResult => ({ code, stdout, stderr: "" });
  const rawDefault = entries
    .map(([s, p], i) => `:${s === "A" ? "000000" : "100644"} ${s === "D" ? "000000" : "100644"} ${s === "A" ? Z40 : oid(i + 1)} ${s === "D" ? Z40 : oid(i + 100)} ${s}\0${p}\0`)
    .join("");
  const numstatDefault = entries.map(([, p]) => `1\t1\t${p}\0`).join("");
  const runner = {
    async run(req: GitRunRequest): Promise<GitRunResult> {
      calls.push(req);
      const a = req.argv;
      const has = (w: string): boolean => a.includes(w);
      if (opts.throwOn !== undefined && has(opts.throwOn)) throw opts.error ?? new Error("boom");
      if (opts.failOn !== undefined && has(opts.failOn)) return { code: 128, stdout: "", stderr: "fatal: planted\n" };
      if (has("--version")) return result(`${opts.version ?? "git version 2.40.0"}\n`);
      if (has("check-attr")) return result((req.stdin ?? "").split("\0").filter(Boolean).map((p) => `${p}\0filter\0unspecified\0`).join(""));
      if (has("--get-regexp")) return { code: 1, stdout: "", stderr: "" };
      if (has("rev-parse")) return result(`${oid(7)}\n`);
      if (has("read-tree") || has("add")) return result("");
      if (has("write-tree")) return result(`${oid(9)}\n`);
      if (has("diff-tree") && has("--raw") && has("--no-renames") && opts.verifyRaw !== undefined) return result(opts.verifyRaw);
      if (has("diff-tree") && has("--raw")) return result(opts.raw ?? rawDefault);
      if (has("diff-tree") && has("--numstat")) return result(opts.numstat ?? numstatDefault);
      if (has("cat-file") && a.some((x) => x.startsWith("--batch-check"))) return result((req.stdin ?? "").split("\n").filter(Boolean).map(() => "10").join("\n") + "\n");
      if (has("cat-file") && has("-s")) return result("10\n");
      if (has("cat-file") && has("blob")) return result(opts.blobs?.[a[a.length - 1] as string] ?? "x\n");
      if (has("diff")) return result(opts.patch ?? "", opts.patchCode ?? 0);
      return result("");
    },
  };
  const gitOps: GitOpsDeps = {
    runner,
    env: { daemon: { PATH: "/usr/bin" }, pty: { PATH: "/usr/bin" } },
    runHooks: false,
    isCliRunActive: () => false,
    assertNoDrift: async () => undefined,
  };
  const dir = mkdtempSync(join(tmpdir(), "axis-review-fake-"));
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  const { provider, counts } = tempIndexes(join(dir, "idx"));
  return {
    counts,
    deps: { git: gitOps, tempIndex: provider, fileExists: async () => false },
    wt: { workTree: "/work/tree", gitDir: "/work/tree/.git" },
    against: oid(7),
    calls,
  };
}
