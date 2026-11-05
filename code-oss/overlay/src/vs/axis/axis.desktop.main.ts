/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

// The desktop entry point of the Axis shell (patches P3, P4, P6 and P7 load
// and bundle it in place of vs/workbench/workbench.desktop.main).

import '../workbench/workbench.desktop.main.js';
import './axis.common.main.js';

export { main } from './electron-browser/axis.main.js';
