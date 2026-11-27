// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// @axis/shell-core: the renderer-safe logic of the own shell (daemon client, reconnect, events, models). It is filled
// by OS-5, which ports the legacy overlay's common/ modules; OS-1 creates the empty, typed package. It imports only
// @axis/protocol and the other renderer packages, never node:*.

/** The package's API version; OS-5 raises it when the ported modules land. */
export const SHELL_CORE_API_VERSION = 0;
