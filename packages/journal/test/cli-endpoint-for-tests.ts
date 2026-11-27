// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// THE one named test helper that may take a switch store's mint (the writer rule): it takes each store's mint once and reuses it,
// so a test can switch the CLI endpoint on directly; no product code may do this.
import type { CliEndpointSwitchRecords, CliEndpointSwitchWrite } from "../src/index.js";

const MINTS = new WeakMap<CliEndpointSwitchRecords, () => CliEndpointSwitchWrite>();

export function switchMintOf(store: CliEndpointSwitchRecords): () => CliEndpointSwitchWrite {
  let m = MINTS.get(store);
  if (m === undefined) {
    m = store.takeSwitchMint();
    MINTS.set(store, m);
  }
  return m;
}

export const switchOnForTests = (store: CliEndpointSwitchRecords): { readonly changed: boolean } => store.switchOn(switchMintOf(store)());
