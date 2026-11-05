/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { INativeWindowConfiguration } from '../../platform/window/common/window.js';
import { Workbench } from '../../workbench/browser/workbench.js';
import { DesktopMain } from '../../workbench/electron-browser/desktop.main.js';
import { AxisWorkbench } from '../browser/workbench.js';

/**
 * The desktop bootstrap of the Axis shell. The upstream service setup in
 * `DesktopMain` stays authoritative; only the workbench class changes
 * (docs/design/axis-shell.md section 3.2, patch P2).
 */
export class AxisDesktopMain extends DesktopMain {

	protected override createWorkbench(...args: ConstructorParameters<typeof Workbench>): Workbench {
		return new AxisWorkbench(...args);
	}
}

export function main(configuration: INativeWindowConfiguration): Promise<void> {
	const desktopMain = new AxisDesktopMain(configuration);

	return desktopMain.open();
}
