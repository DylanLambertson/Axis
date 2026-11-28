// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// One app instance per profile (OS-3.1), taken after main set its name and profile path. A second launch on the same `userData` asks the first to show its window and quits at
// once, before it forks anything, so it never starts a second daemon against the same data directory. A second main with another
// profile but the same data roots is stopped by the daemon's own instance lock instead: its supervisor ends `failed` with reason
// `lock_held` (exit 75), without a restart loop.

export interface InstanceAppLike {
  getPath(name: "userData"): string;
  requestSingleInstanceLock(): boolean;
  on(event: "second-instance", listener: () => void): unknown;
  exit(code: number): void;
}

/**
 * True when this process holds the lock; otherwise it has already asked the app to exit and logged one closed line. `profile` is the
 * userData main set (prepareBeforeReady): Electron takes the lock in the CURRENT userData, so it must already be ours, or the lock
 * would sit in Electron's default profile and a second launch on our profile would not be refused. A mismatch throws.
 */
export function claimSingleInstance(app: InstanceAppLike, profile: string, show: () => void, log: (line: string) => void): boolean {
  if (app.getPath("userData") !== profile) throw new Error("the single-instance lock must be taken after the profile path is set");
  if (!app.requestSingleInstanceLock()) {
    log("another instance of the app is running with this profile: it was asked to show its window");
    app.exit(0);
    return false;
  }
  // The second launch's argv and working directory are never read: they are another process's text.
  app.on("second-instance", () => show());
  return true;
}
