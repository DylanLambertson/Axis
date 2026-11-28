// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The file main forks as the pty process (dist/app/pty.cjs; OS-3.1, docs/design/own-shell-main-seam.md §3 item 2). Audit C M1:
// tiny on purpose; its ONE static import is the guard, and the pty process itself, a separate bundle next to it, comes after by
// import(). Do not add code above or another static import: test/forked-files.test.mjs pins this file's shape, its built size and
// the built load order.
import "@axis/pty-process/signal-guard";

// @ts-expect-error: the bundled entry next to this file at run time (scripts/bundle.mjs), not a source module.
void import("./pty-entry.cjs").then(undefined, () => {
  process.stderr.write("pty entry failed to load\n");
  process.exit(70);
});
