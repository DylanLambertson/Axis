// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// One app instance per profile (OS-3.1). A second launch on the same `userData` asks the first to show its window and quits at
// once, before it forks anything, so it never starts a second daemon against the same data directory. A second main with another
// profile but the same data roots is stopped by the daemon's own instance lock instead: its supervisor ends `failed` with reason
// `lock_held` (exit 75), without a restart loop.

export interface InstanceAppLike {
  requestSingleInstanceLock(): boolean;
  on(event: "second-instance", listener: () => void): unknown;
  exit(code: number): void;
}

/** True when this process holds the lock; otherwise it has already asked the app to exit and logged one closed line. */
export function claimSingleInstance(app: InstanceAppLike, show: () => void, log: (line: string) => void): boolean {
  if (!app.requestSingleInstanceLock()) {
    log("another instance of the app is running with this profile: it was asked to show its window");
    app.exit(0);
    return false;
  }
  app.on("second-instance", () => show());
  return true;
}
