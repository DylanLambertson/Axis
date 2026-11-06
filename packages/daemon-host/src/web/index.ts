// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The web host entry (ticket W1, docs/design/web-host-entry.md). Not exported from the package index: nothing a desktop
// entry loads may reach this directory, and only this directory's server.ts may load a listener module.
export { DEFAULT_WEB_LIMITS, WEB_HOSTS, isSerializedOrigin, parseWebHostConfig, type WebHostAddress, type WebHostConfig, type WebHostLimits } from "./config.js";
export { AUTH_PREFIX, SUBPROTOCOL, UPGRADE_REFUSALS, WS_PATH, type UpgradeRefusal } from "./handshake.js";
export { WEB_ACTOR_ID, WEB_WINDOW_ID, startWebHost, type WebHost, type WebHostEvent, type WebHostOptions, type WebHostStats, type WebRefusal } from "./server.js";
export { CLOSE, type CloseCode } from "./ws-codec.js";
