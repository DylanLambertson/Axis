// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { worktreesMethods } from "@axis/protocol";
import { createWorktreesService, type WorktreesServiceDeps } from "../src/worktrees/service.js";

// DC-7 review 1 NIT-3: the local checkout row survives a full list. The service is driven with a fake manager that lists
// more linked worktrees than the cap (1000); the row is pushed first, so it is kept and the reply still conforms.
// Mutant: the row pushed after the other rows (it would be cut by the cap).

test("a list over the cap keeps the local checkout as its first row", async () => {
  const listed = [
    { path: "/repo", head: "1".repeat(40), branch: "refs/heads/main", locked: false, prunable: false, isMain: true, bare: false, managed: false, external: false, id: null },
    ...Array.from({ length: 1200 }, (_, i) => ({ path: `/wt/${i}`, head: "2".repeat(40), branch: `refs/heads/b${i}`, locked: false, prunable: false, isMain: false, bare: false, managed: false, external: true, id: null })),
  ];
  const deps = {
    journal: { getProject: (id: string) => (id === "p1" ? { id: "p1", path: "/repo" } : undefined), listWorkspaces: () => [] },
    manager: { list: async () => listed },
  } as unknown as WorktreesServiceDeps;
  const { service } = createWorktreesService(deps);
  const ctx = { caller: { actor: "user" as const, connectionId: "c1" }, signal: new AbortController().signal };
  const reply = await service.list({ projectId: "p1", includeLocal: true }, ctx as never);
  assert.equal(reply.worktrees.length, 1000);
  assert.equal(reply.worktrees[0]?.origin, "local");
  assert.equal(worktreesMethods.list.response.safeParse(reply).success, true);
  const plain = await service.list({ projectId: "p1" }, ctx as never);
  assert.equal(plain.worktrees.some((w) => w.origin === "local"), false);
});
