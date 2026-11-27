// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

import { windowIdOf } from "./connect-broker.js";

/**
 * Main's `window.gone` sender (PV-K2 K2-g4a, `docs/design/plugin-grant-contract.md` section 8.4). Main owns the window lifecycle:
 * when a code window is destroyed or its renderer dies, the shell calls `windowGone` with the window's numeric id, and the daemon
 * host ends that window's lifetime epoch even if a connection's close was never reported. It depends on no shell: the own shell's
 * main (own-shell plan OS-3) wires it; the Code OSS seam does not. The target is the supervisor (`DaemonSupervisor.windowGone`),
 * which posts only while the host runs and only what the host's inbound schema accepts.
 */
export interface WindowGoneTarget {
  windowGone(windowId: string): boolean;
}

export interface WindowGoneSender {
  /** `true` when the message was posted. A non-integer, negative or over-long id is refused; a throwing target is `false`. */
  windowGone(codeWindowId: number): boolean;
}

/** The largest id whose `w<n>` the host's schema accepts (ten digits). */
const MAX_CODE_WINDOW_ID = 9_999_999_999;

export function createWindowGoneSender(target: WindowGoneTarget): WindowGoneSender {
  return {
    windowGone(codeWindowId: number): boolean {
      if (typeof codeWindowId !== "number" || !Number.isSafeInteger(codeWindowId) || codeWindowId < 0 || codeWindowId > MAX_CODE_WINDOW_ID) return false;
      try {
        return target.windowGone(windowIdOf(codeWindowId)) === true;
      } catch {
        return false;
      }
    },
  };
}
