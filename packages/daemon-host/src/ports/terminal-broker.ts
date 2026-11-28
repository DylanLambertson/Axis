// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

/**
 * DC-3b's attestation (terminals-contract.md section 5; terminal-trust-revocation.md section 6.1): main brokers the pty process's
 * data ports. It mints each data connection's name for a port it hands to the window that asked, and checks the sender. Without it no
 * data connection can reach a terminal, so a terminal could never be viewed: `axis.terminals/1` is not served until a composition
 * receives one.
 *
 * Only DC-3b's broker makes one. Nothing in the shipped composition does yet, so the contract stays unserved. It is a capability
 * object a real broker hands the composition, never a configuration flag.
 */
export interface TerminalDataBroker {
  readonly dataBroker: true;
}

/** True only for an object whose `dataBroker` is the literal `true`. */
export function isTerminalDataBroker(x: unknown): x is TerminalDataBroker {
  return typeof x === "object" && x !== null && (x as { dataBroker?: unknown }).dataBroker === true;
}
