// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { PluginGrantRecords, PluginGrantWrite, PluginPermission } from "@axis/journal";

/**
 * The approved grant action (PV-K2 K2-g3, `docs/design/plugin-grant-contract.md` section 8.4): the only holder of the journal's
 * grant mint. The host composition takes the mint once (`journal.plugins.takeGrantMint()`) and passes it straight here; it stays
 * in this closure and is never returned, exported or stored anywhere else. The `axis.plugins/1` handler calls `grant` and `enable`
 * only inside a spent tier-4 approval. This module exports exactly one value (a writer rule checks it), so no wrapper can forward
 * the mint or a token.
 */
export interface GrantAction {
  grant(pluginId: string, projectId: string, permission: PluginPermission): void;
  enable(pluginId: string, projectId: string): void;
}

export function createGrantAction(plugins: Pick<PluginGrantRecords, "grant" | "setEnabled">, mint: () => PluginGrantWrite): GrantAction {
  return Object.freeze({
    grant: (pluginId: string, projectId: string, permission: PluginPermission): void => plugins.grant(pluginId, projectId, permission, mint()),
    enable: (pluginId: string, projectId: string): void => plugins.setEnabled(pluginId, projectId, true, mint()),
  });
}
