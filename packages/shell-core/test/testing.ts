// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The node:test replacement of Code OSS's `ensureNoDisposablesAreLeakedInTestSuite` (OS-5): called inside a suite, it
// tracks every disposable created by each test and fails the test when one is still undisposed at its end. The store
// it returns is disposed after each test, before the check. Test support only: nothing in src/ but lifecycle.ts's
// tracker hook refers to it.
import { afterEach, beforeEach } from "node:test";
import { DisposableStore, setDisposableTracker, type IDisposable } from "../src/base/lifecycle.js";

/** Live disposables, by creation order; `describe` names a leak in the failure. */
export function leakTracker(): { readonly live: Set<IDisposable>; readonly install: () => void; readonly uninstall: () => IDisposable[] } {
  const live = new Set<IDisposable>();
  return {
    live,
    install: () => {
      live.clear();
      setDisposableTracker({ created: (d) => live.add(d), disposed: (d) => live.delete(d) });
    },
    uninstall: () => {
      setDisposableTracker(undefined);
      const leaked = [...live];
      live.clear();
      return leaked;
    },
  };
}

export function ensureNoDisposablesAreLeakedInTestSuite(): Pick<DisposableStore, "add"> {
  const tracker = leakTracker();
  let store: DisposableStore | undefined;
  beforeEach(() => {
    tracker.install();
    store = new DisposableStore();
  });
  afterEach(() => {
    store?.dispose();
    store = undefined;
    const leaked = tracker.uninstall();
    if (leaked.length > 0) throw new Error(`${leaked.length} disposable(s) leaked: ${leaked.map((d) => d.constructor.name).join(", ")}`);
  });
  return {
    add: <T extends IDisposable>(d: T): T => {
      if (store === undefined) throw new Error("the suite store is used outside a test");
      return store.add(d);
    },
  };
}
