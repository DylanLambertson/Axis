// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// THE one named test helper that may take a store's grant mint (plugin-grant-writer-rule). It takes the mint of each store once
// and reuses it, so a test can write grants directly; no product code may do this.
import type { PluginGrantRecords, PluginGrantWrite, PluginPermission } from "@axis/journal";

const MINTS = new WeakMap<PluginGrantRecords, () => PluginGrantWrite>();

/** The store's mint, taken once per store and kept here. */
export function mintOf(plugins: PluginGrantRecords): () => PluginGrantWrite {
  let m = MINTS.get(plugins);
  if (m === undefined) {
    m = plugins.takeGrantMint();
    MINTS.set(plugins, m);
  }
  return m;
}

export const grantForTests = (plugins: PluginGrantRecords, pluginId: string, projectId: string, permission: PluginPermission): void => plugins.grant(pluginId, projectId, permission, mintOf(plugins)());
export const enableForTests = (plugins: PluginGrantRecords, pluginId: string, projectId: string): void => plugins.setEnabled(pluginId, projectId, true, mintOf(plugins)());
