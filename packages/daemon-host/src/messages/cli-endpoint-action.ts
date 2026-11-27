// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { CliEndpointSwitchRecords, CliEndpointSwitchWrite } from "@axis/journal";

/**
 * The approved enable action of the CLI endpoint switch (PV-M7 slice 2, `docs/design/axis-messages-shim.md` section 7; the K2-g3
 * pattern): the only holder of the journal's switch mint. The host composition takes the mint once
 * (`journal.cliEndpoint.takeSwitchMint()`) and passes it straight here; it stays in this closure and is never returned, exported
 * or stored anywhere else. The `enableCliEndpoint` handler calls `switchOn` only inside a spent tier-4 approval. This module
 * exports exactly one value (the writer rule checks it), so no wrapper can forward the mint or a token.
 */
export interface CliEndpointSwitchAction {
  switchOn(): { readonly changed: boolean };
}

export function createCliEndpointSwitchAction(store: Pick<CliEndpointSwitchRecords, "switchOn">, mint: () => CliEndpointSwitchWrite): CliEndpointSwitchAction {
  return Object.freeze({ switchOn: (): { readonly changed: boolean } => store.switchOn(mint()) });
}
