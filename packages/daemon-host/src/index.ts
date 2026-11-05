// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Scaffold (ticket H1): configuration, ports, lifecycle registry, logging and error summaries.
// No handlers, contracts or startup sequence yet (H2 onward). Nothing in packages/* imports this package.
export * from "./config.js";
export * from "./disposables.js";
export * from "./exit-codes.js";
export { registerHostSecrets } from "./secrets.js";
export * from "./log/index.js";
export * from "./ports/index.js";
export * from "./control/attestation.js";
export * from "./control/messages.js";
export * from "./control/client.js";
export * from "./control/connect-limiter.js";
export * from "./control/connect-router.js";
export * from "./transport/electron-parent-port.js";
export * from "./transport/mux.js";
