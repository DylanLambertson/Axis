// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The file main forks as the daemon (dist/app/daemon.cjs; OS-3.1, docs/design/own-shell-main-seam.md §3 item 2). Audit C M1:
// Electron's utility process ignores `--disable-sigusr1`, so the SIGUSR1 listener is the control, and it must exist before the
// daemon's module graph loads. This file is tiny on purpose (V8 parses a whole file before its first statement runs): its ONE
// static import is the guard, and the daemon itself, a separate bundle next to it, comes after by import(). Do not add code above
// or another static import: test/forked-files.test.mjs pins this file's shape, its built size and the built load order.
import "@axis/daemon-host/signal-guard";

// @ts-expect-error: the bundled entry next to this file at run time (scripts/bundle.mjs), not a source module.
void import("./daemon-entry.cjs").then(undefined, () => {
  process.stderr.write("daemon entry failed to load\n");
  process.exit(70);
});
