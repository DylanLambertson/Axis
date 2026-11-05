// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { GitOpsDeps } from "@axis/git-ops";

/**
 * Everything `@axis/git-ops` takes (`GitOpsDeps`): ONE runner that routes by `req.context` (`daemon`: the node runner
 * with hooks off; `pty`: the control-channel runner of the Axis pty process), the two environments, `runHooks`, the
 * `isCliRunActive` and `assertNoDrift` guards, and the optional secret scanner. The host builds it once and the git
 * handlers pass it through unchanged.
 */
export type GitPort = GitOpsDeps;
