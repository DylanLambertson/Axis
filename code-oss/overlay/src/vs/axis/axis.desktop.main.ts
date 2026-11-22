/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

// The desktop entry point of the Axis shell (patches P3, P4, P6 and P7 load
// and bundle it in place of vs/workbench/workbench.desktop.main).

import '../workbench/workbench.desktop.main.js';
import './axis.common.main.js';
// The real daemon client (PV-E0): registered after the shared entry, so it replaces the unavailable one on the desktop only.
import './services/daemon/electron-browser/axisRendererDaemonClient.js';

export { main } from './electron-browser/axis.main.js';
