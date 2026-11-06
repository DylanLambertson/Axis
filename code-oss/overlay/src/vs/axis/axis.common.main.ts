/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

// Axis contributions shared by every Axis entry point. Phase A of
// docs/design/axis-shell-stage2.md section 3.5: the upstream workbench main is
// imported wholesale by each platform entry, then these follow, so that Axis
// registrations come after (and override) upstream ones.

//#region --- Axis defaults (restyle)

import '../workbench/contrib/axis/browser/axisDefaults.contribution.js';

//#endregion

//#region --- Axis services

import './services/daemon/browser/axisUnavailableDaemonClient.js';
import './services/view/browser/axisViewService.js';
import './services/workspaces/browser/axisWorkspaceService.js';

//#endregion

//#region --- Axis contributions

import './contrib/view/browser/axisView.contribution.js';
import './contrib/agent/browser/axisAgent.contribution.js';

//#endregion
