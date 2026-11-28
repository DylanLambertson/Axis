// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
process.on("SIGUSR1", () => undefined);

/*
 * Audit C M1, the startup window. SIGUSR1 makes Node open an unauthenticated inspector on 127.0.0.1:9229, from which any local
 * user could read this process's heap. Electron's utility process ignores `--disable-sigusr1` (Electron 45.3.2), so a listener
 * is the control, and it holds only from the statement that installs it. The statement above is this module's first, and the
 * module imports nothing.
 *
 * The file main forks (the shell's, OS-3; never in a package `src/`, which may not load the entry) MUST import this module as
 * its ONE static import and load everything else with `import()` after it:
 *
 *   import "@axis/daemon-host/signal-guard";             // or "@axis/pty-process/signal-guard"
 *   const { runDaemonEntry } = await import("...");      // the entry and its whole module graph, only now
 *
 * ESM evaluates a static import only once the whole static graph is loaded, so an entry imported statically, even second, would
 * delay this listener until after that graph (about 1.2 s to 1.8 s for the daemon). `testing/process-main-child.ts` is that
 * file, and `test/process-main.test.ts` signals it while the entry loads. A bundler must keep this module ahead of the entry's
 * code and must not hoist the entry into the forked file.
 *
 * The listener is silent and never removed (with none, the signal's default applies again); the entry adds its own, which
 * writes the closed line. A signal before this statement still takes the default: the process ends, or the inspector opens
 * (RR-83).
 */
export {};
